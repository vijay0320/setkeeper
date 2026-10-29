import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pricesFrom, defaultPrinting, fairValue, valueFor, conditionFactor, measureConditions, rollConditions,
  printingFromText, conditionFromText, listingPrinting, priceRows, DEFAULT_FACTORS, MIN_PAIRS, type ConditionData,
} from "../src/lib/prices.ts";
import { optimizeCart } from "../src/lib/cart.ts";
import type { MarketSnapshot } from "../src/lib/market.ts";

// TCGdex pricing shape: TCGplayer per printing, Cardmarket one price plus "-holo" for the reverse holo
const pricing = {
  tcgplayer: {
    updated: "2026-10-28", unit: "USD",
    normal: { lowPrice: 0.1, midPrice: 0.3, highPrice: 2, marketPrice: 0.25 },
    "reverse-holofoil": { lowPrice: 0.5, midPrice: 1.1, marketPrice: 0.86 },
  },
  cardmarket: { updated: "2026-10-28", unit: "EUR", low: 0.02, trend: 0.15, avg30: 0.17, "low-holo": 0.3, "trend-holo": 0.7, "avg30-holo": 0.8 },
};
const fx = { usdcad: 1.4, eurcad: 1.5 };

test("keeps every printing and puts Cardmarket's holo price on the reverse holo", () => {
  const ps = pricesFrom(pricing);
  assert.deepEqual(ps.map((p) => p.printing), ["normal", "reverse-holofoil"]);
  assert.deepEqual(ps[0], { printing: "normal", tcg: { low: 0.1, mid: 0.3, market: 0.25, high: 2 }, cm: { low: 0.02, trend: 0.15, avg30: 0.17 } });
  assert.deepEqual(ps[1].cm, { low: 0.3, trend: 0.7, avg30: 0.8 });
  assert.equal(defaultPrinting(ps), "normal");
  // a holo rare: holofoil is the usual printing, ahead of normal and reverse
  assert.equal(defaultPrinting(pricesFrom({ tcgplayer: { "reverse-holofoil": { marketPrice: 3 }, holofoil: { marketPrice: 9 } } })), "holofoil");
  assert.deepEqual(pricesFrom(null), []);
  assert.deepEqual(pricesFrom({ tcgplayer: { unit: "USD" }, cardmarket: null }), []);
});

test("fair value is the mean of the sources, with their range", () => {
  // Umbreon VMAX 215 (2026-10-28): TCGplayer market 2264.70 USD, Cardmarket ~1869 EUR
  const p = { printing: "holofoil", tcg: { market: 2264.7, low: 1500 }, cm: { trend: 1869.1, avg30: 1900 } };
  const f = fairValue(p, { usdcad: 1.38, eurcad: 1.6 })!;
  const r = (n: number) => Math.round(n * 100) / 100;
  const t = r(2264.7 * 1.38), c = r(((1869.1 + 1900) / 2) * 1.6);
  assert.equal(f.nm, r((t + c) / 2));
  assert.equal(f.low, c); // Cardmarket is the lower source here
  assert.equal(f.high, t);
  assert.equal(f.sources.length, 2);
  assert.ok(!f.disagree);
  // TCGplayer's "low" (cheapest listing in any condition) never becomes the value
  const one = fairValue({ printing: "normal", tcg: { low: 0.1, market: 1 } }, fx)!;
  assert.equal(one.nm, 1.4);
  assert.equal(one.low, one.high);
  // far-apart sources are flagged
  assert.ok(fairValue({ printing: "x", tcg: { market: 100 }, cm: { trend: 40 } }, fx)!.disagree);
  assert.equal(fairValue({ printing: "x" }, fx), undefined);
});

test("condition factors: yours, then measured with enough pairs, then the estimate", () => {
  assert.deepEqual(conditionFactor("LP"), { factor: DEFAULT_FACTORS.LP, basis: "estimate" });
  assert.equal(conditionFactor(undefined).factor, 1);
  const data: ConditionData = { overall: { LP: { ratio: 0.9, pairs: MIN_PAIRS }, MP: { ratio: 0.6, pairs: 3 } }, bands: { over100: { LP: { ratio: 0.8, pairs: 12 } } } };
  assert.deepEqual(conditionFactor("LP", data, 5), { factor: 0.9, basis: "measured", pairs: MIN_PAIRS });
  assert.deepEqual(conditionFactor("LP", data, 250), { factor: 0.8, basis: "measured", pairs: 12 }); // the card's value band wins
  assert.equal(conditionFactor("MP", data).basis, "estimate"); // too few pairs
  assert.deepEqual(conditionFactor("MP", data, 5, { MP: 0.65 }), { factor: 0.65, basis: "yours" });
  const v = valueFor(fairValue({ printing: "normal", tcg: { market: 100 }, cm: { trend: 80 } }, fx), "HP")!;
  assert.equal(v.value, Math.round(((140 + 120) / 2) * 0.5 * 100) / 100);
  assert.equal(v.low, 60);
  assert.equal(v.high, 70);
});

test("measures condition discounts within each shop", () => {
  const L = (sellerId: string, cardId: string, condition: string, cad: number, printing?: string) => ({ sellerId, cardId, condition, cad, ...(printing ? { printing } : {}) });
  const m = measureConditions([
    L("a", "1", "NM", 20), L("a", "1", "LP", 17), L("a", "1", "HP", 10),
    L("b", "1", "NM", 30), L("b", "1", "LP", 24), // different shop, its own NM
    L("a", "2", "NM", 200), L("a", "2", "LP", 180),
    L("a", "3", "LP", 5), // no NM to compare with
    L("a", "4", "NM", 10, "reverse-holofoil"), L("a", "4", "LP", 1, "holofoil"), // different printings don't pair
    L("a", "5", "NM", 0.25), L("a", "5", "LP", 0.25), // bulk
    L("a", "6", "NM", 10), L("a", "6", "MP", 25), // mislabelled
  ]);
  assert.deepEqual(m.overall.LP, { ratio: 0.85, pairs: 3 }); // median of 0.85, 0.8, 0.9
  assert.deepEqual(m.overall.HP, { ratio: 0.5, pairs: 1 });
  assert.equal(m.overall.MP, undefined);
  assert.deepEqual(m.bands.over100?.LP, { ratio: 0.9, pairs: 1 });
  assert.deepEqual(m.bands["10to100"]?.LP, { ratio: 0.83, pairs: 2 });

  const d1 = rollConditions(undefined, "2026-10-28", { overall: { LP: { ratio: 0.8, pairs: 10 } }, bands: {} });
  const d2 = rollConditions(d1, "2026-10-29", { overall: { LP: { ratio: 0.9, pairs: 30 } }, bands: {} });
  assert.deepEqual(d2.overall.LP, { ratio: 0.88, pairs: 40 }); // weighted by pairs
  const again = rollConditions(d2, "2026-10-29", { overall: { LP: { ratio: 0.9, pairs: 30 } }, bands: {} });
  assert.equal(again.days!.length, 2); // re-running a day replaces it
});

test("reads printing and condition from shop and eBay text", () => {
  assert.equal(printingFromText("Lightly Played Reverse Holofoil"), "reverse-holofoil");
  assert.equal(printingFromText("Near Mint Holofoil"), "holofoil");
  assert.equal(printingFromText("Charizard 4/102 Base Set 1st Edition Holo"), "1st-edition-holofoil");
  assert.equal(printingFromText("Pikachu - Rev Holo - NM"), "reverse-holofoil");
  assert.equal(printingFromText("Near Mint"), undefined);
  assert.equal(printingFromText("Non-Holo Unlimited"), "unlimited");
  assert.equal(conditionFromText("Lightly Played Reverse Holofoil"), "LP");
  assert.equal(conditionFromText("Moderately Played Holofoil"), "MP");
  assert.equal(conditionFromText("Heavily Played"), "HP");
  assert.equal(conditionFromText("Damaged Holofoil"), "DMG");
  assert.equal(conditionFromText("Near Mint or better"), "NM");
  assert.equal(conditionFromText("Excellent"), "LP");
  assert.equal(conditionFromText("Very good"), "MP");
  assert.equal(conditionFromText("Poor"), "DMG");
  assert.equal(conditionFromText("Ungraded"), undefined);
  assert.equal(conditionFromText("Umbreon ex 161/131"), undefined); // "ex" is not a condition
  assert.equal(listingPrinting("Holo", ["unlimited-holofoil", "1st-edition-holofoil"]), "unlimited-holofoil");
});

test("daily rows: one per printing, the usual one marked", () => {
  const rows = priceRows("sv03.5-025", "sv03.5", "2026-10-29", pricing);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { card_id: "sv03.5-025", printing: "normal", set_id: "sv03.5", day: "2026-10-29", is_default: true,
    tcg_low: 0.1, tcg_mid: 0.3, tcg_market: 0.25, tcg_high: 2, cm_low: 0.02, cm_trend: 0.15, cm_avg30: 0.17 });
  assert.equal(rows[1].is_default, false);
  assert.equal(rows[1].cm_trend, 0.7);
});

test("cart judges each listing against its own condition and printing", () => {
  const snap: MarketSnapshot = {
    fetchedAt: "", sellers: [{ id: "s", name: "Shop", country: "CA", currency: "CAD", kind: "store", shipping: { base: 0 } }],
    listings: [
      { sellerId: "s", cardId: "c", price: 80, qty: 1, condition: "NM" }, // over NM worth (100 × 1.0 tolerance? no: fair)
      { sellerId: "s", cardId: "c", price: 70, qty: 1, condition: "HP" }, // HP is worth 50: a bad buy, not a "30% off" deal
    ],
  };
  const opts = { usdToCad: 1.4, mode: "value" as const, conditions: ["NM", "LP", "MP", "HP", "DMG"], tolerance: 1, scalperAbove: 1.5 };
  const plan = optimizeCart([{ cardId: "c", label: "c", priority: "normal", market: 100 }], snap, opts);
  assert.equal(plan.orders[0].items[0].listing.condition, "NM");
  // the HP copy alone is rejected as overpriced for its condition (70 > 50 × 1.5 is false, so it's an offer, but worth only 50)
  const hpOnly = optimizeCart([{ cardId: "c", label: "c", priority: "normal", market: 100 }], { ...snap, listings: [snap.listings[1]] }, opts);
  assert.equal(hpOnly.cards, 0);
  assert.match(hpOnly.deferred[0].reason, /in HP/);
  // printing: a reverse-holo want skips listings for the usual printing
  const rh = optimizeCart([{ cardId: "c", label: "c", priority: "normal", market: 100, printing: "reverse-holofoil", defaultPrinting: "normal" }],
    { ...snap, listings: [{ sellerId: "s", cardId: "c", price: 50, qty: 1, condition: "NM" }, { sellerId: "s", cardId: "c", price: 90, qty: 1, condition: "NM", printing: "reverse-holofoil" }] }, opts);
  assert.equal(rh.orders[0].items[0].listing.printing, "reverse-holofoil");
  const none = optimizeCart([{ cardId: "c", label: "c", priority: "normal", market: 100, printing: "reverse-holofoil", defaultPrinting: "normal" }],
    { ...snap, listings: [{ sellerId: "s", cardId: "c", price: 50, qty: 1, condition: "NM" }] }, opts);
  assert.equal(none.unavailable[0].reason, "No seller has this printing in stock");
});
