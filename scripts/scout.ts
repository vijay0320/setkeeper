// Price scout: collects in-stock Pokémon singles, every English set, from the shops it may
// read (data/stores/scout-audit.json; the list itself is the SCOUT_SELLERS secret) and, with
// API keys, eBay. Listings are matched to cards with the full TCGdex card list and saved as one
// snapshot per set, so each set's Buy tab gets its own listings. Run daily by
// .github/workflows/scout.yml.
//
// Price history is the project's dataset, so it never goes into the public repo. With
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set, each run is appended to the private
// price_snapshots table (see supabase/setup.sql); the app can read only the newest
// snapshot per set. Without them (local runs), it writes data/listings/<set>.json,
// which .gitignore keeps out of git.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { packArchive } from "./scout/archive.ts";
import type { CardSet } from "../src/lib/types.ts";
import type { Listing, MarketSnapshot, Seller } from "../src/lib/market.ts";
import { fetchShopify, newStats, type Resolver, type ShopifyStore } from "./scout/shopify.ts";
import { matchTitle } from "./scout/match.ts";
import { buildIndex, matchCard, appCard, type CardIndex, type CatalogCard, type CatalogSet } from "../src/lib/cardmatch.ts";
import { ebayToken, fetchEbay, type EbayConfig } from "./scout/ebay.ts";
import { measureConditions, rollConditions, type ConditionData } from "../src/lib/prices.ts";

const BUNDLED = "30th-celebration";
const set = JSON.parse(readFileSync(`data/sets/${BUNDLED}.json`, "utf8")) as CardSet;
const cfgPath = existsSync("data/sellers.json") ? "data/sellers.json" : "data/sellers.example.json";
const cfg = JSON.parse(process.env.SCOUT_SELLERS || readFileSync(cfgPath, "utf8")) as { shopify: ShopifyStore[]; ebay?: EbayConfig & { enabled: boolean } };
const notice = (title: string, msg: string, level = "notice") => { if (process.env.GITHUB_ACTIONS) console.log(`::${level} title=${title}::${msg.replace(/[\r\n]+/g, " ")}`); };

// every English card, so a listing from any set can be placed
async function catalog(): Promise<CardIndex | undefined> {
  try {
    const T = "https://api.tcgdex.net/v2/en";
    const [cards, sets] = await Promise.all([fetch(`${T}/cards`).then((r) => r.json()), fetch(`${T}/sets`).then((r) => r.json())]) as
      [{ id: string; localId: string; name: string }[], { id: string; name: string; cardCount?: { official?: number; total?: number } }[]];
    const S: CatalogSet[] = sets.map((s) => ({ id: s.id, name: s.name, official: s.cardCount?.official ?? 0, total: s.cardCount?.total ?? 0 }));
    const ids = new Set(S.map((s) => s.id));
    const C: CatalogCard[] = cards.map((c) => ({ ...c, setId: c.id.slice(0, c.id.length - c.localId.length - 1) })).filter((c) => ids.has(c.setId));
    console.log(`card list: ${C.length} cards in ${S.length} sets`);
    return buildIndex(C, S);
  } catch (e) { notice("Scout", `Card list unavailable (${(e as Error).message}); matching 30th Celebration only`, "warning"); return undefined; }
}
const idx = await catalog();

/** 30th Celebration titles go through its own matcher (RGB Mew, Classic Collection numbers); everything else through the full card list. */
const resolve: Resolver = (title, extra, collection) => {
  // RGB Mew ("Mew - R/RGB") exists only in the 30th Celebration set
  const in30th = /30th|celebration/i.test(collection) || /\bmew\b.*\b[RGB]\s*\/\s*RGB\b/i.test(title);
  if (in30th || /30th|celebration/i.test(`${title} ${extra}`)) {
    const id = matchTitle(title, set, in30th);
    if (id) return { setId: BUNDLED, cardId: id };
  }
  if (!idx) return { miss: "no card" };
  const m = matchCard(title, idx, `${extra} ${collection.replace(/-/g, " ")}`);
  return m.card ? appCard(m.card) : { miss: m.reason ?? "no card" };
};

const fetchedAt = new Date().toISOString();
const listings: Listing[] = [];
const sources: { name: string; ok: boolean; listings: number; error?: string }[] = [];
const sellers = new Map<string, Seller>();
const complete = new Map<string, boolean>(); // shop read to the end (no paging limit hit)
const report: string[] = [], placeNotes: string[] = [];

for (const store of cfg.shopify ?? []) {
  try {
    const stats = newStats();
    const r = await fetchShopify(store, resolve, fetch, 200, stats);
    sellers.set(store.id, {
      id: store.id, name: store.name, country: store.country, currency: store.currency, kind: "store", url: `https://${store.domain}`, shipping: store.shipping,
      ...(store.province ? { province: store.province } : {}), ...(store.carrier ? { carrier: store.carrier } : {}),
      ...(store.taxAt ? { taxAt: store.taxAt } : {}), ...(store.chargesPst != null ? { chargesPst: store.chargesPst } : {}),
      ...(store.note ? { note: store.note } : {}),
    });
    listings.push(...r.listings);
    const inStock = r.listings.filter((l) => l.qty > 0).length;
    sources.push({ name: store.name, ok: true, listings: inStock });
    const misses = Object.entries(stats.misses).map(([k, v]) => `${v} ${k}`).join(", ");
    const why = `${r.collections.length ? `collections ${r.collections.join(", ")}: ` : ""}${stats.products} products, ${stats.matched} matched to cards (${stats.soldOut} sold out), ${inStock} listings in stock${misses ? `; skipped: ${misses}` : ""}`;
    console.log(`${store.name}: ${why}`);
    complete.set(store.id, stats.notes.length === 0);
    report.push(`${store.name}: ${why}${stats.notes.length ? ` [${stats.notes.join("; ")}]` : ""}`);
    const ex = Object.entries(stats.examples).filter(([k]) => k !== "excluded").map(([k, v]) => `${k}: ${v.join(" | ")}`).join(" ;; ");
    if (ex) placeNotes.push(`${store.name} → ${ex}`);
  } catch (e) {
    sources.push({ name: store.name, ok: false, listings: 0, error: (e as Error).message });
    console.warn(`${store.name}: ${(e as Error).message}`);
    report.push(`${store.name}: FAILED ${(e as Error).message}`);
  }
}

if (cfg.ebay?.enabled) {
  const id = process.env.EBAY_CLIENT_ID, secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) console.log("eBay: EBAY_CLIENT_ID / EBAY_CLIENT_SECRET not set; skipped");
  else {
    try {
      // eBay is searched card by card, so it covers the 30th Celebration set for now (daily API limits)
      const cards = set.cards.filter((c) => c.section !== "Basic Energy");
      const r = await fetchEbay(set, cards, await ebayToken(id, secret), cfg.ebay);
      r.sellers.forEach((s) => sellers.set(s.id, s));
      listings.push(...r.listings.map((l) => ({ ...l, setId: BUNDLED })));
      sources.push({ name: "eBay", ok: true, listings: r.listings.length });
      notice("Scout", `eBay: ${r.listings.length} listings from ${r.sellers.length} sellers`);
    } catch (e) {
      sources.push({ name: "eBay", ok: false, listings: 0, error: (e as Error).message });
      notice("Scout", `eBay: ${(e as Error).message}`, "warning");
    }
  }
}


// Condition discounts measured from these listings (a shop's NM vs played price for the same
// card and printing). Only the aggregate ratios are published, never the listings.
{
  const fx = JSON.parse(readFileSync("data/landed/fx.json", "utf8")) as { usdcad: number };
  const cur = new Map([...sellers.values()].map((x) => [x.id, x.currency]));
  const m = measureConditions(listings.filter((l) => l.qty > 0).map((l) => ({
    sellerId: l.sellerId, cardId: l.cardId, printing: l.printing, condition: l.condition,
    cad: cur.get(l.sellerId) === "USD" ? l.price * fx.usdcad : l.price,
  })));
  const file = "data/prices/conditions.json";
  const prev = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ConditionData) : undefined;
  const pairs = Object.values(m.overall).reduce((a, f) => a + (f?.pairs ?? 0), 0);
  if (pairs) {
    mkdirSync("data/prices", { recursive: true });
    // days measured before the scout asked for Canadian prices (whole-dollar US prices) are dropped
    const clean = prev ? { ...prev, days: (prev.days ?? []).filter((d) => d.priced === "shop-currency") } : undefined;
    const rolled = rollConditions(clean, new Date().toISOString().slice(0, 10), m);
    rolled.days = rolled.days?.map((d) => (d.day === rolled.updatedAt ? { ...d, priced: "shop-currency" } : d));
    writeFileSync(file, JSON.stringify(rolled, null, 1) + "\n");
  }
  notice("Conditions", `${pairs} NM-vs-played pairs measured today`);
  console.log(`condition pairs today: ${pairs} (${Object.entries(m.overall).map(([c, f]) => `${c} ${f!.ratio} × ${f!.pairs}`).join(", ") || "none"})`);
}
// one snapshot per set: the app reads the newest one for the set a collector is working on
const bySet = new Map<string, Listing[]>();
for (const l of listings) { const k = l.setId ?? BUNDLED; const { setId: _s, title: _t, ...rest } = l; (bySet.get(k) ?? bySet.set(k, []).get(k)!).push(rest); }
const rows = [...bySet].map(([setId, ls]) => {
  const ids = new Set(ls.map((l) => l.sellerId));
  const snap: MarketSnapshot = {
    fetchedAt, sellers: [...sellers.values()].filter((s) => ids.has(s.id)), listings: ls,
    sources: sources.filter((x) => !x.ok || [...sellers.values()].some((s) => s.name === x.name && ids.has(s.id)))
      .map((x) => ({ ...x, listings: ls.filter((l) => l.qty > 0 && sellers.get(l.sellerId)?.name === x.name).length })),
  };
  return { set_id: setId, fetched_at: fetchedAt, snapshot: snap };
});
const total = listings.filter((l) => l.qty > 0).length;
// GitHub shows only 10 annotations per step, so the report is combined into a few
notice("Scout", `${total} listings in stock across ${rows.length} sets ⟶ ${report.join(" ‖ ")}`);
if (placeNotes.length) notice("Not placed", placeNotes.join(" ‖ "));

const sbUrl = process.env.SUPABASE_URL?.replace(/\/$/, ""), sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sb = (path: string, body: unknown, prefer = "return=minimal") => fetch(`${sbUrl}/rest/v1/${path}`, {
  method: "POST", headers: { apikey: sbKey!, Authorization: `Bearer ${sbKey}`, "Content-Type": "application/json", Prefer: prefer }, body: JSON.stringify(body),
});
if (!rows.length) console.log("no listings today");
else if (sbUrl && sbKey) {
  // 1. today's listings, one row per set, replaced each run (what the app reads)
  for (let i = 0; i < rows.length; i += 50) {
    const res = await sb("latest_snapshots?on_conflict=set_id", rows.slice(i, i + 50), "resolution=merge-duplicates,return=minimal");
    if (!res.ok) { console.error(`Saving today's listings failed: HTTP ${res.status} ${await res.text()}`); process.exit(1); }
  }
  // 2. history as changes only: a row when a card's price or stock changes at a shop
  const day = fetchedAt.slice(0, 10);
  let changed = 0, gone = 0;
  for (const st of [...sellers.values()].filter((x) => x.kind === "store")) {
    const mine = listings.filter((l) => l.sellerId === st.id).map((l) => ({
      set_id: l.setId ?? BUNDLED, card_id: l.cardId, printing: l.printing ?? "", condition: l.qty > 0 ? l.condition ?? "" : "", price: l.price, in_stock: l.qty > 0, qty: l.qty,
    }));
    let ok = true;
    for (let i = 0; i < mine.length; i += 3000) {
      const res = await sb("rpc/record_listings", { p_seller: st.id, p_day: day, p_rows: mine.slice(i, i + 3000) }, "return=representation");
      if (!res.ok) { ok = false; console.error(`${st.name}: saving changes failed, HTTP ${res.status} ${await res.text()}`); process.exitCode = 1; break; }
      changed += Number(await res.json()) || 0;
    }
    // only a complete read can tell that a listing disappeared
    if (ok && complete.get(st.id)) {
      const res = await sb("rpc/close_listings", { p_seller: st.id, p_day: day }, "return=representation");
      if (res.ok) gone += Number(await res.json()) || 0;
    }
  }
  // 3. the raw run, packed, to a private storage bucket: everything exactly as collected
  // (packed columns + Brotli; read back with unpackArchive in scripts/scout/archive.ts)
  const raw = packArchive(fetchedAt, [...sellers.values()], sources, listings);
  const path = `${fetchedAt.slice(0, 4)}/${fetchedAt.slice(5, 7)}/${fetchedAt.slice(0, 10)}T${fetchedAt.slice(11, 16).replace(":", "")}.listings.br`;
  const up = await fetch(`${sbUrl}/storage/v1/object/scout-archive/${path}`, {
    method: "POST", headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "Content-Type": "application/octet-stream", "x-upsert": "true" }, body: raw,
  });
  const archived = up.ok ? `archived ${(raw.length / 1e6).toFixed(1)} MB` : `archive failed (HTTP ${up.status}: ${(await up.text()).slice(0, 120)})`;
  notice("Saved", `${rows.length} sets of today's listings; history: ${changed} price, stock or quantity changes, ${gone} listings gone; ${archived}`);
} else {
  mkdirSync("data/listings", { recursive: true });
  for (const r of rows) writeFileSync(`data/listings/${r.set_id}.json`, JSON.stringify(r.snapshot));
  console.log(`wrote ${rows.length} files to data/listings/ (kept out of git), ${total} listings in stock`);
}
