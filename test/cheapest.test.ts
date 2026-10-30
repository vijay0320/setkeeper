import { test } from "node:test";
import assert from "node:assert/strict";
import { cheapestAtDoor, fillDays } from "../src/lib/cheapest.ts";
import rules from "../data/landed/rules.json" with { type: "json" };
import type { MarketSnapshot } from "../src/lib/market.ts";
import type { LandedRules } from "../src/lib/landed.ts";

const snap: MarketSnapshot = {
  fetchedAt: "",
  sellers: [
    { id: "a", name: "Shop A", country: "CA", currency: "CAD", kind: "store", province: "ON", shipping: { base: 10, freeOver: 100 } },
    { id: "b", name: "Shop B", country: "CA", currency: "CAD", kind: "store", province: "BC", shipping: { base: 2 } },
  ],
  listings: [
    { sellerId: "a", cardId: "c", price: 20, qty: 1, condition: "NM" },
    { sellerId: "a", cardId: "c", price: 15, qty: 0, condition: "NM" }, // sold out
    { sellerId: "b", cardId: "c", price: 24, qty: 1, condition: "NM" },
    { sellerId: "b", cardId: "c", price: 12, qty: 1, condition: "HP" },
  ],
};

test("cheapest at your door counts each shop's shipping and your tax", () => {
  const nm = cheapestAtDoor(snap, "c", 1.4, { conditions: ["NM"] });
  assert.deepEqual(nm.map((d) => [d.seller.id, d.total]), [["b", 26], ["a", 30]]); // $24+2 beats $20+10
  const landed = cheapestAtDoor(snap, "c", 1.4, { conditions: ["NM"], landed: { province: "BC", rules: rules as unknown as LandedRules } });
  assert.ok(landed[0].total > 26); // GST (+ BC PST from a BC shop)
  assert.equal(cheapestAtDoor(snap, "c", 1.4)[0].listing.condition, "HP"); // any condition: the HP copy
  assert.deepEqual(cheapestAtDoor(undefined, "c", 1.4), []);
});

test("fills the days between price changes", () => {
  const f = fillDays([{ day: "2026-10-28", v: 1 }, { day: "2026-10-30", v: 3 }], "2026-10-31");
  assert.deepEqual(f.map((x) => `${x.day}:${x.v}`), ["2026-10-28:1", "2026-10-29:1", "2026-10-30:3", "2026-10-31:3"]);
});
