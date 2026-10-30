// Shopify storefronts expose their catalogue at /products.json (public, read-only). The scout
// reads only collections it is allowed to read (see scripts/shop-audit.ts): a shop's Pokémon
// singles collection(s), politely, page by page.
import type { Listing } from "../../src/lib/market.ts";
import { normalizeCondition } from "../../src/lib/market.ts";
import { printingFromText } from "../../src/lib/prices.ts";
import { robotsRules, blocked } from "../shop-audit.ts";

export interface ShopifyStore {
  id: string;
  name: string;
  domain: string; // e.g. "example-cards.ca"
  /** Collection handles to read, e.g. ["pokemon-singles"]. */
  collections?: string[];
  /** Older single-collection form. */
  collection?: string;
  /** Find the shop's Pokémon singles collection(s) from its public collection list. */
  pokemonSingles?: boolean;
  currency: "CAD" | "USD";
  shipping: { base: number; perExtra?: number; freeOver?: number };
  country: string;
  // landed-cost hints passed through to the app (see src/lib/landed.ts)
  province?: import("../../src/lib/landed.ts").Province;
  carrier?: "post" | "courier";
  taxAt?: "checkout" | "border" | "none";
  chargesPst?: boolean;
  note?: string;
}

export interface Product {
  title: string; handle: string; tags?: string[] | string; product_type?: string;
  variants: { title: string; price: string; available?: boolean; inventory_quantity?: number }[];
}

/** Which card a product is: app set and card id, or why not (for the run summary). */
export type Resolver = (title: string, extra: string, collection: string) => { setId: string; cardId: string } | { miss: string };

/** Why products were or weren't used, for the run summary. */
export interface ScanStats { products: number; matched: number; soldOut: number; misses: Record<string, number>; unmatched: string[]; examples: Record<string, string[]>; notes: string[] }
export const newStats = (): ScanStats => ({ products: 0, matched: 0, soldOut: 0, misses: {}, unmatched: [], examples: {}, notes: [] });

export function listingsFromProducts(store: ShopifyStore, products: Product[], resolve: Resolver, collection = "", stats?: ScanStats): Listing[] {
  const out: Listing[] = [];
  for (const p of products) {
    if (stats) stats.products++;
    const extra = `${Array.isArray(p.tags) ? p.tags.join(" ") : p.tags ?? ""} ${p.product_type ?? ""}`;
    const r = resolve(p.title, extra, collection);
    if ("miss" in r) {
      if (stats) {
        stats.misses[r.miss] = (stats.misses[r.miss] ?? 0) + 1;
        const ex = (stats.examples[r.miss] ??= []);
        if (ex.length < 3) ex.push(p.title);
        // sealed product and accessories are expected; show examples of cards we couldn't place
        if (!["excluded", "no number"].includes(r.miss) && stats.unmatched.length < 6) stats.unmatched.push(p.title);
      }
      continue;
    }
    if (stats) stats.matched++;
    const before = out.length;
    for (const v of p.variants) {
      const qty = v.inventory_quantity != null ? Math.max(0, v.inventory_quantity) : v.available ? 1 : 0;
      const price = Number(v.price);
      if (!qty || !(price > 0)) continue;
      // shops put the condition and often the printing in the variant ("Lightly Played Reverse Holofoil")
      const printing = printingFromText(v.title) ?? printingFromText(p.title);
      out.push({
        sellerId: store.id, setId: r.setId, cardId: r.cardId, price, qty,
        condition: normalizeCondition(v.title === "Default Title" ? "NM" : v.title),
        ...(printing ? { printing } : {}),
        url: `https://${store.domain}/products/${p.handle}`, title: p.title,
      });
    }
    if (out.length === before) {
      if (stats) stats.soldOut++;
      // keep a sold-out marker (qty 0) so the app can say "sold out at <shop>" instead of guessing;
      // the cart and price checks only use listings with stock
      const prices = p.variants.map((v) => Number(v.price)).filter((x) => x > 0);
      if (prices.length) out.push({ sellerId: store.id, setId: r.setId, cardId: r.cardId, price: Math.min(...prices), qty: 0, url: `https://${store.domain}/products/${p.handle}`, title: p.title });
    }
  }
  return out;
}

const UA = "SetKeeper price scout (+https://github.com/vijay0320/setkeeper)";
const PAUSE = 700;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** One request, retried after a pause when the shop is briefly busy (429 or 5xx). */
export async function getWithRetry(fetchFn: typeof fetch, url: string, waits = [5000, 20000]): Promise<Response> {
  for (let i = 0; ; i++) {
    const r = await fetchFn(url, { headers: { "User-Agent": UA } });
    if ((r.status === 429 || r.status >= 500) && i < waits.length) { await sleep(Number(r.headers.get("retry-after")) * 1000 || waits[i]); continue; }
    return r;
  }
}

/** A shop's Pokémon singles collection(s), from its public collection list (titles only). */
export function singlesCollections(cols: { handle: string; title: string; products_count?: number }[]): string[] {
  const pick = cols.filter((c) => /pok[eé]mon/i.test(c.title) && /single/i.test(c.title) && !/japan|chinese|korean|sealed|graded|slab|bulk|lot/i.test(c.title))
    .sort((a, b) => (b.products_count ?? 0) - (a.products_count ?? 0));
  // the biggest "Pokémon singles" collection usually holds them all; keep one more in case it's split
  return pick.slice(0, 2).map((c) => c.handle);
}

export async function collectionsFor(store: ShopifyStore, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const set = new Set([...(store.collections ?? []), ...(store.collection ? [store.collection] : [])]);
  if (store.pokemonSingles) {
    const cols: { handle: string; title: string; products_count?: number }[] = [];
    for (let page = 1; page <= 20; page++) {
      const r = await getWithRetry(fetchFn, `https://${store.domain}/collections.json?limit=250&page=${page}`);
      if (!r.ok) break;
      const j = (await r.json()) as { collections?: typeof cols };
      if (!j.collections?.length) break;
      cols.push(...j.collections);
      await sleep(PAUSE);
      if (j.collections.length < 250) break;
    }
    for (const h of singlesCollections(cols)) set.add(h);
  }
  return [...set];
}

export async function fetchShopify(store: ShopifyStore, resolve: Resolver, fetchFn: typeof fetch = fetch, maxPages = 200, stats?: ScanStats): Promise<{ listings: Listing[]; collections: string[] }> {
  // robots.txt is checked every run, so a shop that asks bots to stay out is left alone from that day
  const rb = await fetchFn(`https://${store.domain}/robots.txt`, { headers: { "User-Agent": UA } }).catch(() => undefined);
  const rules = rb?.ok ? robotsRules(await rb.text()) : [];
  const no = blocked("/collections.json", rules) ?? blocked("/collections/x/products.json", rules);
  if (no) throw new Error(`robots.txt asks bots not to read the catalogue (Disallow: ${no}); skipped`);
  const handles = await collectionsFor(store, fetchFn);
  // never fall back to a shop's whole catalogue when its Pokémon singles collection wasn't found
  if (!handles.length && store.pokemonSingles) throw new Error("no Pokémon singles collection found; skipped");
  const bases = handles.length ? handles.map((h) => ({ h, url: `https://${store.domain}/collections/${h}/products.json` })) : [{ h: "", url: `https://${store.domain}/products.json` }];
  const all: Listing[] = [];
  const seen = new Set<string>();
  for (const b of bases) {
    for (let page = 1; page <= maxPages; page++) {
      const res = await getWithRetry(fetchFn, `${b.url}?limit=250&page=${page}`);
      if (!res.ok) {
        // Shopify stops paging deep collections (about 25,000 products); keep what was read
        if (page > 1) { stats?.notes.push(`${b.h || "catalogue"} stopped at page ${page} (HTTP ${res.status}), ${(page - 1) * 250} products read`); break; }
        throw new Error(`HTTP ${res.status}`);
      }
      const { products } = (await res.json()) as { products: Product[] };
      if (!products?.length) break;
      const fresh = products.filter((p) => !seen.has(p.handle));
      fresh.forEach((p) => seen.add(p.handle));
      all.push(...listingsFromProducts(store, fresh, resolve, b.h, stats));
      await sleep(PAUSE); // be polite
      if (products.length < 250) break;
    }
  }
  return { listings: all, collections: handles };
}
