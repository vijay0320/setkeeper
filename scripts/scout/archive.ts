// The scout's raw daily archive, packed small: columns instead of repeated labels, shop links
// stored as the product handle, repeated values as indexes into a short list, then Brotli.
// unpackArchive() gives back exactly what was collected.
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import type { Listing, Seller } from "../../src/lib/market.ts";

interface Packed {
  v: 1; fetchedAt: string; sellers: Seller[]; sources: unknown[];
  dict: { seller: string[]; set: string[]; condition: string[]; printing: string[] };
  cols: { seller: number[]; set: number[]; card: string[]; price: number[] /* cents */; qty: number[]; condition: number[]; printing: number[]; url: string[]; title: string[]; shipping: (number | null)[] };
}

/** Shopify's product handle is usually the title as a slug, so only what differs is kept. */
export const slug = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function packArchive(fetchedAt: string, sellers: Seller[], sources: unknown[], all: Listing[]): Buffer {
  // rows grouped by shop and card compress far better
  const listings = [...all].sort((a, b) => a.sellerId.localeCompare(b.sellerId) || a.cardId.localeCompare(b.cardId));
  const dict = { seller: [] as string[], set: [] as string[], condition: [] as string[], printing: [] as string[] };
  const at = (k: keyof typeof dict, v: string | undefined) => { const s = v ?? ""; let i = dict[k].indexOf(s); if (i < 0) { i = dict[k].length; dict[k].push(s); } return i; };
  const base = new Map(sellers.map((s) => [s.id, `${s.url ?? ""}/products/`]));
  const cols: Packed["cols"] = { seller: [], set: [], card: [], price: [], qty: [], condition: [], printing: [], url: [], title: [], shipping: [] };
  for (const l of listings) {
    cols.seller.push(at("seller", l.sellerId)); cols.set.push(at("set", l.setId)); cols.card.push(l.cardId);
    cols.price.push(Math.round(l.price * 100)); cols.qty.push(l.qty); cols.condition.push(at("condition", l.condition)); cols.printing.push(at("printing", l.printing));
    const b = base.get(l.sellerId), u = l.url ?? "";
    // "" = handle is the title's slug, "+x" = slug followed by x, "h" = another handle, "=url" = a full link
    const h = b && u.startsWith(b) ? u.slice(b.length) : undefined, sl = slug(l.title ?? "");
    cols.url.push(!u ? "!" : h === undefined ? `=${u}` : h === sl ? "" : sl && h.startsWith(sl) ? `+${h.slice(sl.length)}` : h);
    cols.title.push(l.title ?? ""); cols.shipping.push(l.shipping ?? null);
  }
  const packed: Packed = { v: 1, fetchedAt, sellers, sources, dict, cols };
  return brotliCompressSync(Buffer.from(JSON.stringify(packed)), { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24 } });
}

/** The listings come back grouped by shop and card (the order they're stored in). */
export function unpackArchive(buf: Buffer): { fetchedAt: string; sellers: Seller[]; sources: unknown[]; listings: Listing[] } {
  const p = JSON.parse(brotliDecompressSync(buf).toString()) as Packed;
  const base = new Map(p.sellers.map((s) => [s.id, `${s.url ?? ""}/products/`]));
  const listings: Listing[] = p.cols.card.map((cardId, i) => {
    const sellerId = p.dict.seller[p.cols.seller[i]], c = p.cols.url[i], sl = slug(p.cols.title[i]);
    const u = c === "!" ? "" : c.startsWith("=") ? c : base.get(sellerId) + (c === "" ? sl : c.startsWith("+") ? sl + c.slice(1) : c);
    const set = p.dict.set[p.cols.set[i]], cond = p.dict.condition[p.cols.condition[i]], pr = p.dict.printing[p.cols.printing[i]];
    return {
      sellerId, ...(set ? { setId: set } : {}), cardId, price: p.cols.price[i] / 100, qty: p.cols.qty[i],
      ...(cond ? { condition: cond } : {}), ...(pr ? { printing: pr } : {}),
      ...(u ? { url: u.startsWith("=") ? u.slice(1) : u } : {}),
      ...(p.cols.title[i] ? { title: p.cols.title[i] } : {}), ...(p.cols.shipping[i] != null ? { shipping: p.cols.shipping[i]! } : {}),
    } as Listing;
  });
  return { fetchedAt: p.fetchedAt, sellers: p.sellers, sources: p.sources, listings };
}
