// Writes data/listings/sample.json: FICTIONAL sellers and prices so the cart optimizer
// can be tried before any real price data exists. Never presented as real prices.
import { readFileSync, writeFileSync } from "node:fs";
import type { CardSet } from "../src/lib/types.ts";
import type { MarketSnapshot, Seller } from "../src/lib/market.ts";

const set = JSON.parse(readFileSync("data/sets/30th-celebration.json", "utf8")) as CardSet;
let seed = 2026;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const band: Record<string, [number, number]> = {
  Regular: [0.25, 0.8], "Double Rare (ex)": [1.5, 4], "Pikachu Rare": [2, 6], "Special Art Rare": [8, 22],
  "Special Art ex": [25, 110], "Futuristic Rare": [160, 280], "RGB Mew": [70, 140], Classic: [4, 30],
};
const sellers: Seller[] = [
  { id: "sample-maple", name: "Maple Leaf Cards (sample)", country: "CA", currency: "CAD", kind: "store", shipping: { base: 6, freeOver: 75 } },
  { id: "sample-coast", name: "Coastline Collectibles (sample)", country: "CA", currency: "CAD", kind: "store", shipping: { base: 4.5, perExtra: 0.1, freeOver: 120 } },
  { id: "sample-north", name: "Northern Binder (sample)", country: "CA", currency: "CAD", kind: "store", shipping: { base: 20 } },
  { id: "sample-prairie", name: "Prairie Pulls (sample)", country: "CA", currency: "CAD", kind: "store", shipping: { base: 3, freeOver: 40 } },
  { id: "sample-lakes", name: "Great Lakes TCG (sample)", country: "US", currency: "USD", kind: "store", shipping: { base: 9, freeOver: 100 } },
  { id: "sample-ebay-a", name: "pallettown_ca (sample eBay)", country: "CA", currency: "CAD", kind: "marketplace" },
  { id: "sample-ebay-b", name: "holo_haven (sample eBay)", country: "US", currency: "USD", kind: "marketplace" },
];
const fx = 1.38;
const snap: MarketSnapshot = { fetchedAt: "2026-10-27T12:00:00Z", sample: true, sellers, listings: [],
  sources: [{ name: "Sample data (fictional sellers and prices)", ok: true, listings: 0 }] };
for (const c of set.cards) {
  const b = band[c.rarity];
  if (!b) continue;
  const market = b[0] + (b[1] - b[0]) * rnd();
  for (const s of sellers) {
    const p = s.kind === "store" ? (c.rarity === "Regular" ? 0.75 : 0.45) : 0.3;
    if (rnd() > p) continue;
    let price = market * (0.85 + rnd() * 0.45) / (s.currency === "USD" ? fx : 1);
    if (rnd() < 0.04) price *= 1.9; // the odd scalper ask
    price = Math.max(0.25, Math.round(price * 100) / 100);
    snap.listings.push({
      sellerId: s.id, cardId: c.id, price, qty: 1 + Math.floor(rnd() * 3),
      condition: rnd() < 0.8 ? "NM" : "LP",
      ...(s.kind === "marketplace" ? { shipping: c.rarity === "Regular" ? 1.75 : 4.5 } : {}),
    });
  }
}
snap.sources![0].listings = snap.listings.length;
writeFileSync("data/listings/sample.json", JSON.stringify(snap));
console.log(`sample: ${snap.listings.length} listings from ${sellers.length} fictional sellers`);
