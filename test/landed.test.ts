import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { landedCost, importLimit, PROVINCES, type LandedRules } from "../src/lib/landed.ts";
import { optimizeCart } from "../src/lib/cart.ts";
import type { MarketSnapshot } from "../src/lib/market.ts";

const rules = JSON.parse(readFileSync("data/landed/rules.json", "utf8")) as LandedRules;
const ctx = (province: "BC" | "ON" | "AB" | "QC" | "NS", fxFee = 0.025) => ({ province, rules, fxFee });

test("rules cover every province and territory", () => {
  for (const p of PROVINCES) { const r = rules.provinces[p]; assert.ok(r.hst || r.gst, p); }
  assert.equal(rules.provinces.ON.hst, 0.13);
  assert.equal(rules.provinces.NS.hst, 0.14);
  assert.equal(rules.provinces.QC.pst, 0.09975);
});

test("a BC shop charges GST and PST to a BC buyer; an Ontario shop charges HST to an Ontario buyer", () => {
  const bc = landedCost({ country: "CA", currency: "CAD", province: "BC" }, 100, 10, ctx("BC"));
  assert.deepEqual([bc.gstHst, bc.pst, bc.fxFee, bc.fees, bc.total], [5.5, 7.7, 0, 0, 123.2]);
  const on = landedCost({ country: "CA", currency: "CAD", province: "AB" }, 100, 10, ctx("ON"));
  assert.deepEqual([on.gstHst, on.pst, on.total], [14.3, 0, 124.3]);
  // an out-of-province shop doesn't charge BC PST by default
  const ab = landedCost({ country: "CA", currency: "CAD", province: "AB" }, 100, 10, ctx("BC"));
  assert.deepEqual([ab.gstHst, ab.pst], [5.5, 0]);
});

test("US order by mail: under CA$20 nothing at the border; over it, tax plus Canada Post's fee", () => {
  const small = landedCost({ country: "US", currency: "USD" }, 18, 5, ctx("BC"));
  assert.deepEqual([small.gstHst, small.pst, small.fees, small.fxFee], [0, 0, 0, 0.58]);
  assert.match(small.note!, /under the CA\$20/i);
  const big = landedCost({ country: "US", currency: "USD" }, 100, 8, ctx("BC"));
  assert.deepEqual([big.duty, big.gstHst, big.pst, big.fees], [0, 5, 7, 9.95]);
  assert.equal(big.total, 100 + 8 + 2.7 + 5 + 7 + 9.95);
});

test("US order by courier uses the CUSMA CA$40 tax limit; brokerage when tax is due", () => {
  const under = landedCost({ country: "US", currency: "USD", carrier: "courier" }, 39, 10, ctx("ON"));
  assert.deepEqual([under.gstHst, under.fees], [0, 0]);
  const over = landedCost({ country: "US", currency: "USD", carrier: "courier" }, 200, 10, ctx("ON"));
  assert.deepEqual([over.gstHst, over.fees], [26, 15]);
  assert.equal(importLimit({ country: "US", currency: "USD", carrier: "courier" }, rules), 40);
  assert.equal(importLimit({ country: "JP", currency: "USD", carrier: "courier" }, rules), 20);
  assert.equal(importLimit({ country: "CA", currency: "CAD" }, rules), undefined);
});

test("Quebec collects QST on imports; Alberta only GST", () => {
  const qc = landedCost({ country: "US", currency: "USD" }, 100, 0, ctx("QC", 0));
  assert.deepEqual([qc.gstHst, qc.pst], [5, 9.98]);
  const ab = landedCost({ country: "US", currency: "USD" }, 100, 0, { province: "AB" as const, rules, fxFee: 0 });
  assert.deepEqual([ab.gstHst, ab.pst, ab.total], [5, 0, 114.95]);
});

test("cart optimiser picks the cheaper landed option, not the cheaper sticker price", () => {
  // A US seller is $3 cheaper per card on the sticker, but a $60 order crosses the CA$20 mail limit
  const snap: MarketSnapshot = {
    fetchedAt: "", sellers: [
      { id: "us", name: "US Shop", country: "US", currency: "USD", kind: "store", shipping: { base: 5 } },
      { id: "ca", name: "BC Shop", country: "CA", currency: "CAD", kind: "store", province: "BC", shipping: { base: 5 } },
    ],
    listings: [
      { sellerId: "us", cardId: "a", price: 17, qty: 1 }, { sellerId: "us", cardId: "b", price: 17, qty: 1 }, { sellerId: "us", cardId: "c", price: 17, qty: 1 },
      { sellerId: "ca", cardId: "a", price: 20, qty: 1 }, { sellerId: "ca", cardId: "b", price: 20, qty: 1 }, { sellerId: "ca", cardId: "c", price: 20, qty: 1 },
    ],
  };
  const wants = ["a", "b", "c"].map((id) => ({ cardId: id, label: id, priority: "normal" as const, market: 20 }));
  const base = { usdToCad: 1, mode: "complete" as const, conditions: ["NM"], tolerance: 1.15, scalperAbove: 2 };
  const sticker = optimizeCart(wants, snap, base);
  assert.equal(sticker.orders[0].seller.id, "us");
  const landed = optimizeCart(wants, snap, { ...base, landed: ctx("BC") });
  // BC shop: 60 + 5 + 12% tax = 72.80; US: 51 + 5 + FX 1.40 + 12% on 51 + 9.95 = 73.47
  assert.equal(landed.total, 72.8);
  assert.ok(landed.orders.every((o) => o.seller.id === "ca"));
  assert.equal(landed.extrasTotal, 7.8);
});
