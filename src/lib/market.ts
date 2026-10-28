// Sellers, their shipping rules and the listings they have for each card.

export interface ShippingRule {
  base: number; // charged once per order, in the seller's currency
  perExtra?: number; // added for each item after the first
  freeOver?: number; // order subtotal (seller's currency) at which shipping becomes free
}

export interface Seller {
  id: string;
  name: string;
  country: string; // ISO code, "CA" first in the UI
  currency: "CAD" | "USD";
  kind: "store" | "marketplace";
  url?: string;
  /** Store-wide shipping. Marketplace sellers usually price shipping per listing instead. */
  shipping?: ShippingRule;
  note?: string;
  /** Landed-cost hints (see landed.ts): seller's province, where tax is charged, how it ships. */
  province?: import("./landed.ts").Province;
  taxAt?: "checkout" | "border" | "none";
  carrier?: "post" | "courier";
  chargesPst?: boolean;
}

export interface Listing {
  sellerId: string;
  cardId: string;
  price: number; // seller's currency
  qty: number; // units available (0 = sold out)
  condition?: string; // NM, LP, MP, HP, DMG
  url?: string;
  shipping?: number; // per-listing shipping (marketplaces), seller's currency
  title?: string;
}

export interface MarketSnapshot {
  fetchedAt: string;
  sample?: boolean; // true for demo data
  sellers: Seller[];
  listings: Listing[];
  sources?: { name: string; ok: boolean; listings: number; error?: string }[];
}

export const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const;

export function normalizeCondition(s?: string): string | undefined {
  if (!s) return undefined;
  const t = s.toLowerCase();
  if (/near mint|^nm|mint/.test(t)) return "NM";
  if (/lightly|^lp|excellent/.test(t)) return "LP";
  if (/moderately|^mp|good/.test(t)) return "MP";
  if (/heavily|^hp|played|poor/.test(t)) return "HP";
  if (/damag/.test(t)) return "DMG";
  return s.toUpperCase().slice(0, 3);
}

/** Convert a seller-currency amount to CAD. */
export const toCAD = (amount: number, currency: Seller["currency"], usdToCad: number) =>
  currency === "USD" ? amount * usdToCad : amount;

/** Order shipping for a seller given the items in the order (amounts already in CAD). */
export function orderShipping(seller: Seller, items: { price: number; shipping?: number }[], usdToCad: number): number {
  if (!items.length) return 0;
  const perListing = items.reduce((a, i) => a + (i.shipping ?? 0), 0);
  const rule = seller.shipping;
  if (!rule) return perListing;
  const subtotal = items.reduce((a, i) => a + i.price, 0);
  if (rule.freeOver != null && subtotal >= toCAD(rule.freeOver, seller.currency, usdToCad) - 1e-9) return perListing;
  return perListing + toCAD(rule.base + (rule.perExtra ?? 0) * (items.length - 1), seller.currency, usdToCad);
}

/** Parse a listings sheet: Seller, Card #, Price, Qty, Condition, Shipping, Free over, Currency, URL (flexible headers). */
export function listingsFromRows(rows: (string | number | null)[][], resolveCard: (num: string, section?: string) => string | undefined): { listings: Listing[]; sellers: Seller[]; skipped: number } {
  const head = rows[0].map((c) => String(c ?? "").trim().toLowerCase());
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const c = {
    seller: col(/seller|store|shop/), number: col(/card\s*#|number|^no/), section: col(/section/),
    price: col(/^price|asking/), qty: col(/qty|quantity|stock/), cond: col(/cond/), ship: col(/ship/), url: col(/url|link/),
    currency: col(/currency/), freeOver: col(/free/),
  };
  if (c.seller < 0 || c.number < 0 || c.price < 0) throw new Error('Listings need "Seller", "Card #" and "Price" columns.');
  const sellers = new Map<string, Seller>();
  const listings: Listing[] = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const name = String(r[c.seller] ?? "").trim();
    const num = String(r[c.number] ?? "").trim();
    const price = Number(String(r[c.price] ?? "").replace(/[^0-9.]/g, ""));
    if (!name || !num || !Number.isFinite(price) || price <= 0) { if (name || num) skipped++; continue; }
    const cardId = resolveCard(num, c.section >= 0 ? String(r[c.section] ?? "") : undefined);
    if (!cardId) { skipped++; continue; }
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    // "Shipping" in a listings sheet is the store's order shipping; "Free over" its free-shipping line.
    const ship = c.ship >= 0 ? Number(String(r[c.ship] ?? "").replace(/[^0-9.]/g, "")) : NaN;
    if (!sellers.has(id)) {
      const cur = String(c.currency >= 0 ? r[c.currency] ?? "" : "").toUpperCase() === "USD" ? "USD" : "CAD";
      const free = c.freeOver >= 0 ? Number(r[c.freeOver]) : NaN;
      sellers.set(id, { id, name, country: cur === "USD" ? "US" : "CA", currency: cur, kind: "store",
        shipping: { base: Number.isFinite(ship) ? ship : 0, ...(Number.isFinite(free) && free > 0 ? { freeOver: free } : {}) } });
    }
    listings.push({
      sellerId: id, cardId, price,
      qty: c.qty >= 0 && String(r[c.qty] ?? "") !== "" ? Number(r[c.qty]) : 1,
      condition: normalizeCondition(c.cond >= 0 ? String(r[c.cond] ?? "") : undefined),
      url: c.url >= 0 ? String(r[c.url] ?? "") || undefined : undefined,
    });
  }
  return { listings, sellers: [...sellers.values()], skipped };
}
