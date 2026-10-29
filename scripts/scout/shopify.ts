// Shopify storefronts expose their catalogue at /products.json (public, read-only).
import type { CardSet } from "../../src/lib/types.ts";
import type { Listing } from "../../src/lib/market.ts";
import { normalizeCondition } from "../../src/lib/market.ts";
import { printingFromText } from "../../src/lib/prices.ts";
import { matchTitle } from "./match.ts";

export interface ShopifyStore {
  id: string;
  name: string;
  domain: string; // e.g. "example-cards.ca"
  collection?: string; // collection handle holding the set's singles; omit to scan the whole catalogue
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

interface Product { title: string; handle: string; variants: { title: string; price: string; available?: boolean; inventory_quantity?: number }[] }

export function listingsFromProducts(store: ShopifyStore, products: Product[], set: CardSet): Listing[] {
  const out: Listing[] = [];
  for (const p of products) {
    const cardId = matchTitle(p.title, set);
    if (!cardId) continue;
    for (const v of p.variants) {
      const qty = v.inventory_quantity != null ? Math.max(0, v.inventory_quantity) : v.available ? 1 : 0;
      const price = Number(v.price);
      if (!qty || !(price > 0)) continue;
      // shops put the condition and often the printing in the variant ("Lightly Played Reverse Holofoil")
      const printing = printingFromText(v.title) ?? printingFromText(p.title);
      out.push({
        sellerId: store.id, cardId, price, qty,
        condition: normalizeCondition(v.title === "Default Title" ? "NM" : v.title),
        ...(printing ? { printing } : {}),
        url: `https://${store.domain}/products/${p.handle}`, title: p.title,
      });
    }
  }
  return out;
}

export async function fetchShopify(store: ShopifyStore, set: CardSet, fetchFn: typeof fetch = fetch, maxPages = 40): Promise<Listing[]> {
  const base = store.collection ? `https://${store.domain}/collections/${store.collection}/products.json` : `https://${store.domain}/products.json`;
  const all: Listing[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchFn(`${base}?limit=250&page=${page}`, { headers: { "User-Agent": "SetKeeper price scout (+https://github.com/)" } });
    if (!res.ok) throw new Error(`${store.name}: HTTP ${res.status}`);
    const { products } = (await res.json()) as { products: Product[] };
    if (!products?.length) break;
    all.push(...listingsFromProducts(store, products, set));
    await new Promise((r) => setTimeout(r, 600)); // be polite
  }
  return all;
}
