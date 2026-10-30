// Prices a collector saw at a shop and logged themselves ("sightings").
//
// For shops whose terms don't allow automated reading, SetKeeper only links to the shop's own
// search page (the collector looks, as any visitor would) and lets them log what they saw.
// Recent sightings join the Buy tab as listings, with the shop's published shipping, so the
// cart optimizer can use them next to the scout's listings.
import type { Card } from "./types.ts";
import type { MarketSnapshot, Seller, Listing } from "./market.ts";

export interface Sighting {
  shop: string; // directory shop id (data/stores/stores.json), or a free-text name
  price: number; // CAD, as shown by the shop
  condition?: "NM" | "LP" | "MP" | "HP" | "DMG";
  printing?: string;
  date: string; // YYYY-MM-DD
}

export interface DirectoryShop {
  id: string; name: string; url: string; country: string; currency: string; province?: string;
  shipping?: { base?: number; freeOver?: number; tiers?: { under?: number; cards?: number; cost: number }[] };
}

/** Shops with big 30th Celebration singles collections, offered as "check stock" links. */
export const CHECK_SHOPS = ["401games", "3dragons", "hobbiesville", "kanzengames", "danireon", "fusiongaming", "pokejeux", "facetoface"];
/** Used when a shop only shows its shipping rate at checkout. */
export const SHIPPING_ESTIMATE = 6;
export const SIGHTING_DAYS = 14;
export const MAX_SIGHTINGS = 8;

/** The shop's own search page for a card (opened by the collector, never fetched by SetKeeper). */
export function searchUrl(shop: DirectoryShop, card: Card): string {
  const num = card.number.match(/^\d+\/\d+/)?.[0] ?? "";
  const name = card.name.replace(/\s*\(.*?\)\s*/g, " ").trim();
  return `${new URL(shop.url).origin}/search?q=${encodeURIComponent(`${name} ${num}`.trim())}`;
}

/** Add a sighting, newest first, replacing an earlier one from the same shop for the same condition and printing. */
export function addSighting(list: Sighting[] | undefined, s: Sighting): Sighting[] {
  const rest = (list ?? []).filter((x) => !(x.shop === s.shop && (x.condition ?? "NM") === (s.condition ?? "NM") && (x.printing ?? "") === (s.printing ?? "")));
  return [s, ...rest].slice(0, MAX_SIGHTINGS);
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/**
 * The market snapshot plus the collector's recent sightings as listings. A sighting older than
 * SIGHTING_DAYS is left out (stock moves fast). Shops get their published shipping, or an
 * estimate that's labelled as one.
 */
export function withSightings(snap: MarketSnapshot | undefined, sightings: Record<string, Sighting[] | undefined>, shops: DirectoryShop[], today: string): MarketSnapshot | undefined {
  const listings: Listing[] = [];
  const sellers = new Map<string, Seller>((snap?.sellers ?? []).map((s) => [s.id, s]));
  for (const [cardId, list] of Object.entries(sightings)) {
    for (const s of list ?? []) {
      const age = daysBetween(s.date, today);
      if (!(s.price > 0) || age < 0 || age > SIGHTING_DAYS) continue;
      const shop = shops.find((x) => x.id === s.shop);
      const id = shop ? shop.id : `seen:${s.shop.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      if (!sellers.has(id)) {
        const base = shop?.shipping?.base ?? shop?.shipping?.tiers?.[0]?.cost;
        sellers.set(id, {
          id, name: shop?.name ?? s.shop, country: shop?.country ?? "CA", currency: shop?.currency === "USD" ? "USD" : "CAD", kind: "store",
          ...(shop ? { url: shop.url } : {}),
          shipping: { base: base ?? SHIPPING_ESTIMATE, ...(shop?.shipping?.freeOver != null ? { freeOver: shop.shipping.freeOver } : {}) },
          ...(shop?.province ? { province: shop.province as Seller["province"] } : {}),
          note: base == null ? `Shipping estimated at $${SHIPPING_ESTIMATE}; the shop shows its rate at checkout.` : undefined,
        });
      }
      listings.push({
        sellerId: id, cardId, price: s.price, qty: 1, condition: s.condition ?? "NM",
        ...(s.printing ? { printing: s.printing } : {}),
        title: `Seen by you ${age === 0 ? "today" : age === 1 ? "yesterday" : `${age} days ago`}`,
      });
    }
  }
  if (!listings.length) return snap;
  const base: MarketSnapshot = snap ?? { fetchedAt: new Date(today).toISOString(), sellers: [], listings: [] };
  return { ...base, sellers: [...sellers.values()], listings: [...base.listings, ...listings], sources: [...(base.sources ?? []), { name: "Prices you logged", ok: true, listings: listings.length }] };
}
