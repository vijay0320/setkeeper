import { test } from "node:test";
import assert from "node:assert/strict";
import { searchUrl, addSighting, withSightings, SIGHTING_DAYS, type DirectoryShop } from "../src/lib/sightings.ts";
import { optimizeCart } from "../src/lib/cart.ts";

const shop: DirectoryShop = { id: "401games", name: "401 Games", url: "https://store.401games.ca", country: "CA", currency: "CAD", province: "ON", shipping: { base: 3, freeOver: 30 } };
const card = { id: "092", section: "Main Set", number: "092/128", name: "Umbreon ex", rarity: "Special Art ex" };

test("links to the shop's own search for the exact card", () => {
  assert.equal(searchUrl(shop, card), "https://store.401games.ca/search?q=Umbreon%20ex%20092%2F128");
  assert.equal(searchUrl(shop, { ...card, name: "Mew (Red)", number: "R/RGB" }), "https://store.401games.ca/search?q=Mew");
});

test("a new sighting replaces the same shop's for that condition and printing", () => {
  let l = addSighting(undefined, { shop: "401games", price: 30, date: "2026-10-20" });
  l = addSighting(l, { shop: "401games", price: 28, date: "2026-10-25" });
  l = addSighting(l, { shop: "401games", price: 22, condition: "LP", date: "2026-10-25" });
  assert.deepEqual(l.map((x) => x.price), [22, 28]);
});

test("recent sightings join the market as listings with the shop's shipping", () => {
  const snap = withSightings(undefined, {
    "092": [{ shop: "401games", price: 28, date: "2026-10-28" }],
    "001": [{ shop: "401games", price: 1, date: "2026-09-01" }], // too old
    "002": [{ shop: "Local Shop", price: 2, date: "2026-10-29" }],
  }, [shop], "2026-10-29")!;
  assert.equal(snap.listings.length, 2);
  assert.deepEqual(snap.sellers.find((s) => s.id === "401games")!.shipping, { base: 3, freeOver: 30 });
  const local = snap.sellers.find((s) => s.id === "seen:local-shop")!;
  assert.match(local.note!, /estimated/);
  assert.ok(SIGHTING_DAYS >= 7);
  const plan = optimizeCart([{ cardId: "092", label: "Umbreon", priority: "normal", market: 40 }], snap, { usdToCad: 1.4, mode: "value", conditions: ["NM"], tolerance: 1.15, scalperAbove: 1.5 });
  assert.equal(plan.orders[0].seller.name, "401 Games");
  assert.equal(withSightings(undefined, {}, [shop], "2026-10-29"), undefined);
});
