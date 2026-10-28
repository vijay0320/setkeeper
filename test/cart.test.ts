import { test } from "node:test";
import assert from "node:assert/strict";
import { optimizeCart, type CartOptions, type Want } from "../src/lib/cart.ts";
import { orderShipping, listingsFromRows, type MarketSnapshot, type Seller } from "../src/lib/market.ts";
import { parseCSV } from "../src/lib/transfer.ts";

const opts = (o: Partial<CartOptions> = {}): CartOptions => ({ usdToCad: 1.38, mode: "value", conditions: ["NM", "LP"], tolerance: 1.15, scalperAbove: 1.5, ...o });
const want = (id: string, market?: number, priority: Want["priority"] = "normal"): Want => ({ cardId: id, label: id, priority, market });
const store = (id: string, base: number, freeOver?: number, currency: "CAD" | "USD" = "CAD"): Seller =>
  ({ id, name: id, country: currency === "CAD" ? "CA" : "US", currency, kind: "store", shipping: { base, ...(freeOver ? { freeOver } : {}) } });

test("shipping rules", () => {
  const s = store("a", 5, 25);
  assert.equal(orderShipping(s, [{ price: 10 }], 1.38), 5);
  assert.equal(orderShipping(s, [{ price: 10 }, { price: 15 }], 1.38), 0);
  assert.equal(orderShipping({ ...s, shipping: { base: 2, perExtra: 0.5 } }, [{ price: 1 }, { price: 1 }, { price: 1 }], 1), 3);
  assert.equal(orderShipping({ ...s, shipping: undefined }, [{ price: 1, shipping: 4 }], 1), 4);
});

test("doesn't pay $20 shipping for fifteen 50-cent cards", () => {
  const wants = Array.from({ length: 15 }, (_, i) => want("c" + i, 0.5));
  const snap: MarketSnapshot = { fetchedAt: "", sellers: [store("bulk", 20, 100)],
    listings: wants.map((w) => ({ sellerId: "bulk", cardId: w.cardId, price: 0.5, qty: 4, condition: "NM" })) };
  const plan = optimizeCart(wants, snap, opts());
  assert.equal(plan.cards, 0);
  assert.equal(plan.deferred.length, 15);
  assert.match(plan.deferred[0].reason, /shipping it alone/);
});

test("buys a $150 card even with shipping, and adds the cheap cards when they unlock free shipping", () => {
  const cheap = Array.from({ length: 15 }, (_, i) => want("c" + i, 0.5));
  const big = want("big", 150, "chase");
  const snap: MarketSnapshot = { fetchedAt: "", sellers: [store("shop", 20, 155)],
    listings: [...cheap.map((w) => ({ sellerId: "shop", cardId: w.cardId, price: 0.5, qty: 3, condition: "NM" })),
      { sellerId: "shop", cardId: "big", price: 150, qty: 1, condition: "NM" }] };
  const plan = optimizeCart([...cheap, big], snap, opts());
  assert.equal(plan.orders.length, 1);
  assert.ok(plan.orders[0].items.some((i) => i.cardId === "big"));
  assert.equal(plan.orders[0].shipping, 0, "cheap cards push the order over $155 so shipping is free");
  assert.ok(plan.cards >= 11);
  assert.ok(plan.total < 150 + 20, "cheaper than the big card plus shipping");
});

test("consolidates onto one seller when shipping outweighs small price gaps", () => {
  const wants = ["a", "b", "c", "d"].map((id) => want(id, 6));
  const snap: MarketSnapshot = { fetchedAt: "", sellers: [store("x", 8, 20), store("y", 8, 20)],
    listings: [
      { sellerId: "x", cardId: "a", price: 5, qty: 1 }, { sellerId: "x", cardId: "b", price: 5.5, qty: 1 },
      { sellerId: "x", cardId: "c", price: 5.6, qty: 1 }, { sellerId: "x", cardId: "d", price: 5.4, qty: 1 },
      { sellerId: "y", cardId: "a", price: 5.2, qty: 1 }, { sellerId: "y", cardId: "b", price: 5.0, qty: 1 },
      { sellerId: "y", cardId: "c", price: 5.1, qty: 1 }, { sellerId: "y", cardId: "d", price: 5.6, qty: 1 }] };
  const plan = optimizeCart(wants, snap, opts({ mode: "complete" }));
  assert.equal(plan.orders.length, 1);
  assert.equal(plan.shippingTotal, 0);
  assert.ok(plan.naiveTotal > plan.total, "beats buying each card at its cheapest price");
});

test("complete mode buys everything available", () => {
  const wants = Array.from({ length: 5 }, (_, i) => want("c" + i, 0.5));
  const snap: MarketSnapshot = { fetchedAt: "", sellers: [store("bulk", 20)],
    listings: wants.map((w) => ({ sellerId: "bulk", cardId: w.cardId, price: 0.5, qty: 1 })) };
  assert.equal(optimizeCart(wants, snap, opts({ mode: "complete" })).cards, 5);
});

test("skips scalper asks, sold-out listings and excluded conditions", () => {
  const wants = [want("a", 10), want("b", 10), want("c", 10)];
  const snap: MarketSnapshot = { fetchedAt: "", sellers: [store("s", 0)],
    listings: [{ sellerId: "s", cardId: "a", price: 40, qty: 1 }, { sellerId: "s", cardId: "b", price: 9, qty: 0 },
      { sellerId: "s", cardId: "c", price: 9, qty: 2, condition: "HP" }] };
  const plan = optimizeCart(wants, snap, opts({ mode: "complete" }));
  assert.equal(plan.cards, 0);
  assert.equal(plan.unavailable.length, 3);
});

test("USD sellers are converted to CAD", () => {
  const snap: MarketSnapshot = { fetchedAt: "", sellers: [store("us", 0, undefined, "USD")], listings: [{ sellerId: "us", cardId: "a", price: 10, qty: 1 }] };
  const plan = optimizeCart([want("a", 20)], snap, opts());
  assert.equal(plan.orders[0].items[0].price, 13.8);
});

test("matches brute force on random small markets", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let worst = 0, exact = 0, runs = 0;
  for (let t = 0; t < 60; t++) {
    const nw = 3 + Math.floor(rnd() * 4), ns = 2 + Math.floor(rnd() * 3);
    const sellers = Array.from({ length: ns }, (_, s) => store("s" + s, Math.round(rnd() * 12), rnd() < 0.6 ? Math.round(10 + rnd() * 40) : undefined));
    const wants = Array.from({ length: nw }, (_, i) => want("w" + i, Math.round((0.5 + rnd() * 30) * 100) / 100, (["normal", "high", "low", "chase"] as const)[Math.floor(rnd() * 4)]));
    const listings = wants.flatMap((w) => sellers.filter(() => rnd() < 0.7).map((s) => ({ sellerId: s.id, cardId: w.cardId, price: Math.round(w.market! * (0.7 + rnd() * 0.6) * 100) / 100, qty: 1 })));
    for (const mode of ["value", "complete"] as const) {
      const ex: { best?: number } = {};
      const plan = optimizeCart(wants, { fetchedAt: "", sellers, listings }, opts({ mode, exhaustive: ex }));
      const gap = plan.objective - ex.best!;
      worst = Math.max(worst, gap); runs++; if (gap < 0.005) exact++;
      assert.ok(gap < 0.5, `trial ${t} ${mode}: heuristic ${plan.objective.toFixed(2)} vs optimum ${ex.best!.toFixed(2)}`);
    }
  }
  console.log(`optimal in ${exact}/${runs} markets; worst gap $${worst.toFixed(2)}`);
});

test("reads a listings sheet", () => {
  const csv = "Seller,Card #,Price,Qty,Condition,Shipping,Free over\nMaple Cards,092/128,4.25,2,Near Mint,6,50\nMaple Cards,999/999,1,1,NM,6,50\n";
  const r = listingsFromRows(parseCSV(csv), (num) => (num === "092/128" ? "092" : undefined));
  assert.equal(r.listings.length, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.listings[0].condition, "NM");
  assert.deepEqual(r.sellers[0].shipping, { base: 6, freeOver: 50 });
});

test("handles a full set's worth of wants quickly", () => {
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const sellers = Array.from({ length: 12 }, (_, s) => store("s" + s, 3 + Math.round(rnd() * 15), rnd() < 0.7 ? 35 + Math.round(rnd() * 80) : undefined));
  const wants = Array.from({ length: 70 }, (_, i) => want("w" + i, i % 10 === 0 ? 40 + rnd() * 150 : 0.3 + rnd() * 3));
  const listings = wants.flatMap((w) => sellers.filter(() => rnd() < 0.5).map((s) => ({ sellerId: s.id, cardId: w.cardId, price: Math.round(w.market! * (0.75 + rnd() * 0.5) * 100) / 100, qty: 2 })));
  const t0 = Date.now();
  const plan = optimizeCart(wants, { fetchedAt: "", sellers, listings }, opts());
  const ms = Date.now() - t0;
  console.log(`70 wants x 12 sellers: ${plan.cards} bought, ${plan.orders.length} orders, $${plan.total} (naive $${plan.naiveTotal}), ${ms} ms`);
  assert.ok(ms < 5000);
});
