// Price scout: collects in-stock singles from configured shops and eBay for the app's
// cart optimizer. Run daily by .github/workflows/scout.yml.
//
// Price history is the project's dataset, so it never goes into the public repo. With
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set, each run is appended to the private
// price_snapshots table (see supabase/setup.sql); the app can read only the newest
// snapshot per set. Without them (local runs), it writes data/listings/<set>.json,
// which .gitignore keeps out of git. The shop list can come from the SCOUT_SELLERS
// secret so the sources stay private too.
// Usage: node scripts/scout.ts [--set 30th-celebration] [--only-missing collection.json]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import type { CardSet } from "../src/lib/types.ts";
import type { MarketSnapshot, Seller } from "../src/lib/market.ts";
import { fetchShopify, type ShopifyStore } from "./scout/shopify.ts";
import { ebayToken, fetchEbay, type EbayConfig } from "./scout/ebay.ts";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const setId = arg("--set") ?? "30th-celebration";
const set = JSON.parse(readFileSync(`data/sets/${setId}.json`, "utf8")) as CardSet;
const cfgPath = existsSync("data/sellers.json") ? "data/sellers.json" : "data/sellers.example.json";
const cfg = JSON.parse(process.env.SCOUT_SELLERS || readFileSync(cfgPath, "utf8")) as { shopify: ShopifyStore[]; ebay?: EbayConfig & { enabled: boolean } };

let cards = set.cards.filter((c) => c.section !== "Basic Energy");
const missingFrom = arg("--only-missing");
if (missingFrom) {
  const col = JSON.parse(readFileSync(missingFrom, "utf8"));
  cards = cards.filter((c) => !["have", "upgrade"].includes(col.entries?.[c.id]?.status));
}

const snap: MarketSnapshot = { fetchedAt: new Date().toISOString(), sellers: [], listings: [], sources: [] };
const sellers = new Map<string, Seller>();

for (const store of cfg.shopify ?? []) {
  try {
    const ls = await fetchShopify(store, set);
    sellers.set(store.id, { id: store.id, name: store.name, country: store.country, currency: store.currency, kind: "store", url: `https://${store.domain}`, shipping: store.shipping });
    snap.listings.push(...ls);
    snap.sources!.push({ name: store.name, ok: true, listings: ls.length });
    console.log(`${store.name}: ${ls.length} listings`);
  } catch (e) {
    snap.sources!.push({ name: store.name, ok: false, listings: 0, error: (e as Error).message });
    console.warn(`${store.name}: ${(e as Error).message}`);
  }
}

if (cfg.ebay?.enabled) {
  const id = process.env.EBAY_CLIENT_ID, secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) snap.sources!.push({ name: "eBay", ok: false, listings: 0, error: "EBAY_CLIENT_ID / EBAY_CLIENT_SECRET not set" });
  else {
    try {
      const r = await fetchEbay(set, cards, await ebayToken(id, secret), cfg.ebay);
      r.sellers.forEach((s) => sellers.set(s.id, s));
      snap.listings.push(...r.listings);
      snap.sources!.push({ name: "eBay", ok: true, listings: r.listings.length });
      console.log(`eBay: ${r.listings.length} listings from ${r.sellers.length} sellers`);
    } catch (e) {
      snap.sources!.push({ name: "eBay", ok: false, listings: 0, error: (e as Error).message });
      console.warn(`eBay: ${(e as Error).message}`);
    }
  }
}

snap.sellers = [...sellers.values()];
const sbUrl = process.env.SUPABASE_URL?.replace(/\/$/, ""), sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (sbUrl && sbKey) {
  const res = await fetch(`${sbUrl}/rest/v1/price_snapshots`, {
    method: "POST",
    headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ set_id: setId, fetched_at: snap.fetchedAt, snapshot: snap }),
  });
  if (!res.ok) { console.error(`Saving to Supabase failed: HTTP ${res.status} ${await res.text()}`); process.exit(1); }
  console.log(`saved ${setId} snapshot to Supabase: ${snap.listings.length} listings, ${snap.sellers.length} sellers`);
} else {
  mkdirSync("data/listings", { recursive: true });
  writeFileSync(`data/listings/${setId}.json`, JSON.stringify(snap));
  console.log(`wrote data/listings/${setId}.json (kept out of git): ${snap.listings.length} listings, ${snap.sellers.length} sellers`);
}
