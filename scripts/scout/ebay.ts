// eBay Browse API (official). Needs an eBay developer app: EBAY_CLIENT_ID / EBAY_CLIENT_SECRET.
import type { Card, CardSet } from "../../src/lib/types.ts";
import type { Listing, Seller } from "../../src/lib/market.ts";
import { normalizeCondition } from "../../src/lib/market.ts";
import { matchTitle } from "./match.ts";

export interface EbayConfig { marketplace: string; deliveryCountry: string; perCard: number; sellerCountries?: string[] }

interface ItemSummary {
  title: string; itemWebUrl: string; condition?: string;
  price: { value: string; currency: string };
  shippingOptions?: { shippingCost?: { value: string; currency: string } }[];
  seller?: { username: string; feedbackPercentage?: string; feedbackScore?: number };
  itemLocation?: { country?: string };
  estimatedAvailabilities?: { estimatedAvailableQuantity?: number }[];
}

export async function ebayToken(id: string, secret: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64") },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!res.ok) throw new Error(`eBay token: HTTP ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

export function query(card: Card): string {
  return `${card.name} ${card.number.includes("RGB") ? "RGB" : card.number} 30th Celebration`;
}

export function fromItems(items: ItemSummary[], card: Card, set: CardSet, cfg: EbayConfig) {
  const sellers: Seller[] = [];
  const listings: Listing[] = [];
  for (const it of items) {
    if (matchTitle(it.title, set) !== card.id) continue;
    const country = it.itemLocation?.country ?? "";
    if (cfg.sellerCountries?.length && !cfg.sellerCountries.includes(country)) continue;
    const currency = it.price.currency === "USD" ? "USD" : it.price.currency === "CAD" ? "CAD" : undefined;
    if (!currency || !it.seller?.username) continue;
    if (Number(it.seller.feedbackPercentage ?? 100) < 97) continue;
    const ship = it.shippingOptions?.[0]?.shippingCost;
    const id = `ebay:${it.seller.username}`;
    sellers.push({ id, name: `${it.seller.username} (eBay)`, country, currency, kind: "marketplace" });
    listings.push({
      sellerId: id, cardId: card.id, price: Number(it.price.value),
      qty: it.estimatedAvailabilities?.[0]?.estimatedAvailableQuantity ?? 1,
      condition: normalizeCondition(it.condition) ?? "NM",
      shipping: ship && ship.currency === it.price.currency ? Number(ship.value) : 0,
      url: it.itemWebUrl, title: it.title,
    });
  }
  return { sellers, listings };
}

export async function fetchEbay(set: CardSet, cards: Card[], token: string, cfg: EbayConfig, fetchFn: typeof fetch = fetch) {
  const sellers = new Map<string, Seller>();
  const listings: Listing[] = [];
  for (const card of cards) {
    const params = new URLSearchParams({
      q: query(card), limit: String(cfg.perCard), sort: "price",
      filter: `buyingOptions:{FIXED_PRICE},deliveryCountry:${cfg.deliveryCountry}`,
    });
    const res = await fetchFn(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
      headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": cfg.marketplace },
    });
    if (!res.ok) throw new Error(`eBay search (${card.name}): HTTP ${res.status}`);
    const body = (await res.json()) as { itemSummaries?: ItemSummary[] };
    const r = fromItems(body.itemSummaries ?? [], card, set, cfg);
    for (const s of r.sellers) sellers.set(s.id, s);
    listings.push(...r.listings);
    await new Promise((r) => setTimeout(r, 250));
  }
  return { sellers: [...sellers.values()], listings };
}
