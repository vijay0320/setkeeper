// The cheapest way to get one card to your door: every in-stock listing of the card, priced
// with the shop's shipping for a single card and, when a landed-cost context is given, sales
// tax, FX fees and border costs for the buyer's province (src/lib/landed.ts).
import { landedCost, type LandedContext } from "./landed.ts";
import { orderShipping, toCAD, type Listing, type MarketSnapshot, type Seller } from "./market.ts";

export interface DoorPrice { seller: Seller; listing: Listing; price: number; shipping: number; total: number }

export function cheapestAtDoor(snap: MarketSnapshot | undefined, cardId: string, usdToCad: number, opts: { conditions?: string[]; printing?: string; landed?: LandedContext } = {}): DoorPrice[] {
  if (!snap) return [];
  const sellers = new Map(snap.sellers.map((s) => [s.id, s]));
  const out: DoorPrice[] = [];
  for (const l of snap.listings) {
    if (l.cardId !== cardId || l.qty <= 0) continue;
    if (opts.conditions?.length && !opts.conditions.includes(l.condition ?? "NM")) continue;
    if (opts.printing && l.printing && l.printing !== opts.printing) continue;
    const s = sellers.get(l.sellerId);
    if (!s) continue;
    const price = toCAD(l.price, s.currency, usdToCad), ship = toCAD(l.shipping ?? 0, s.currency, usdToCad);
    const shipping = orderShipping(s, [{ price, shipping: ship }], usdToCad);
    const total = opts.landed ? landedCost(s, price, shipping, opts.landed).total : price + shipping;
    out.push({ seller: s, listing: l, price: Math.round(price * 100) / 100, shipping: Math.round(shipping * 100) / 100, total: Math.round(total * 100) / 100 });
  }
  // one row per shop (its best offer), cheapest first; Canadian shops win ties
  const best = new Map<string, DoorPrice>();
  for (const d of out) { const b = best.get(d.seller.id); if (!b || d.total < b.total) best.set(d.seller.id, d); }
  return [...best.values()].sort((a, b) => a.total - b.total || Number(b.seller.country === "CA") - Number(a.seller.country === "CA"));
}

/** A daily series from sparse change rows: each day takes the latest value on or before it. */
export function fillDays<T extends { day: string }>(rows: T[], until: string): T[] {
  if (!rows.length) return [];
  const sorted = [...rows].sort((a, b) => a.day.localeCompare(b.day));
  const out: T[] = [];
  let i = 0, cur = sorted[0];
  for (let d = new Date(sorted[0].day + "T00:00:00Z"); d.toISOString().slice(0, 10) <= until; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    while (i < sorted.length && sorted[i].day <= day) cur = sorted[i++];
    out.push({ ...cur, day });
  }
  return out;
}
