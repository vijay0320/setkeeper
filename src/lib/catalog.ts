// Every Pokémon TCG set, past and future, from TCGdex (https://tcgdex.dev): a free,
// open card database with images and TCGplayer/Cardmarket prices, CORS-enabled.
import type { Card, CardSet } from "./types.ts";
import { pricesFrom, defaultPrinting, cmValue, type PrintingPrice, type RawPricing } from "./prices.ts";

export const TCGDEX = "https://api.tcgdex.net/v2/en";

export interface SetSummary {
  id: string;
  name: string;
  series: string; // series id, e.g. "sv"
  logo?: string;
  symbol?: string;
  total: number;
  official: number;
}

export interface CardInfo {
  rarity?: string;
  usd?: number; // TCGplayer market price of the card's usual printing
  eur?: number; // Cardmarket price of the card's usual printing
  prices?: PrintingPrice[]; // every printing (normal, holofoil, reverse holo…), see prices.ts
}

export interface CatalogCache {
  set: CardSet;
  fetchedAt: string;
  info: Record<string, CardInfo>; // by card id
  enrichedAt?: string;
}

type Fetch = typeof fetch;
const json = async <T>(f: Fetch, url: string): Promise<T> => {
  const r = await f(url);
  if (!r.ok) throw new Error(`Card database: HTTP ${r.status}`);
  return (await r.json()) as T;
};

/** Series id from an asset URL like https://assets.tcgdex.net/en/sv/sv03.5/logo */
const seriesOf = (url?: string) => url?.match(/assets\.tcgdex\.net\/(?:en|univ)\/([^/]+)\//)?.[1] ?? "other";

/** Physical-card sets only (TCG Pocket is a digital game). */
export function summariesFrom(raw: { id: string; name: string; logo?: string; symbol?: string; cardCount: { total: number; official: number } }[]): SetSummary[] {
  return raw
    .map((s) => ({ id: s.id, name: s.name, series: seriesOf(s.logo ?? s.symbol), logo: s.logo, symbol: s.symbol, total: s.cardCount?.total ?? 0, official: s.cardCount?.official ?? 0 }))
    .filter((s) => s.series !== "tcgp" && s.total > 0);
}

export async function fetchSetList(f: Fetch = fetch): Promise<{ sets: SetSummary[]; series: Record<string, string> }> {
  const [sets, series] = await Promise.all([
    json<Parameters<typeof summariesFrom>[0]>(f, `${TCGDEX}/sets`),
    json<{ id: string; name: string }[]>(f, `${TCGDEX}/series`).catch(() => []),
  ]);
  return { sets: summariesFrom(sets), series: Object.fromEntries(series.map((s) => [s.id, s.name])) };
}

interface RawSet {
  id: string; name: string; logo?: string; symbol?: string; releaseDate?: string;
  serie?: { id: string; name: string };
  cardCount: { total: number; official: number };
  cards: { id: string; localId: string; name: string; image?: string }[];
}

/** Turn a TCGdex set into the app's set shape. Rarity is filled in later by enrichment. */
export function setFrom(raw: RawSet, info: Record<string, CardInfo> = {}): CardSet {
  const official = raw.cardCount?.official || raw.cards.length;
  const width = String(official).length;
  const cards: Card[] = raw.cards.map((c) => {
    const n = Number(c.localId);
    const numeric = Number.isFinite(n) && /^\d+$/.test(c.localId);
    const section = !numeric ? "Subset" : n <= official ? "Main Set" : "Secret Rare";
    return {
      id: c.id,
      section,
      number: numeric ? `${c.localId.padStart(width, "0")}/${official}` : c.localId,
      name: c.name,
      rarity: info[c.id]?.rarity ?? "Unknown",
      ...(c.image ? { image: c.image } : {}),
    };
  });
  const order = ["Main Set", "Secret Rare", "Subset"];
  const sections = order.filter((s) => cards.some((c) => c.section === s));
  return {
    id: raw.id, name: raw.name, series: raw.serie?.name ?? "", language: "en", releaseDate: raw.releaseDate ?? "",
    imageBase: "", imageSuffix: "/low.webp", sections, rarities: rarityOrder(cards.map((c) => c.rarity)),
    sources: [`https://tcgdex.dev (set ${raw.id})`], cards, ...(raw.logo ? { logo: raw.logo } : {}),
  } as CardSet;
}

const RARITY_RANK = ["Common", "Uncommon", "Rare", "Rare Holo", "Double rare", "Ultra Rare", "Illustration rare", "Special illustration rare", "Hyper rare", "Mega Hyper Rare", "Shiny rare", "Shiny Ultra Rare", "ACE SPEC Rare", "Secret Rare", "Rare Secret", "Rare Rainbow", "None", "Unknown"];
export function rarityOrder(rs: string[]): string[] {
  const uniq = [...new Set(rs)];
  const rank = (r: string) => { const i = RARITY_RANK.findIndex((x) => x.toLowerCase() === r.toLowerCase()); return i < 0 ? 50 : i; };
  return uniq.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export async function fetchSet(id: string, f: Fetch = fetch): Promise<RawSet> {
  return json<RawSet>(f, `${TCGDEX}/sets/${encodeURIComponent(id)}`);
}

interface RawCard {
  id: string; rarity?: string;
  pricing?: RawPricing | null;
}

/** Rarity and every printing's prices from a TCGdex card; usd/eur are the usual printing's. */
export function infoFrom(c: RawCard): CardInfo {
  const out: CardInfo = {};
  if (c.rarity && c.rarity !== "None") out.rarity = c.rarity;
  const prices = pricesFrom(c.pricing);
  if (!prices.length) return out;
  out.prices = prices;
  const d = prices.find((p) => p.printing === defaultPrinting(prices));
  const usd = d?.tcg?.market ?? d?.tcg?.mid, eur = cmValue(d?.cm);
  if (usd != null) out.usd = usd;
  if (eur != null) out.eur = Math.round(eur * 100) / 100;
  return out;
}

/** Fetch rarity and prices for many cards with limited concurrency. */
export async function enrich(ids: string[], onProgress: (done: number, total: number) => void = () => {}, f: Fetch = fetch, concurrency = 8): Promise<Record<string, CardInfo>> {
  const out: Record<string, CardInfo> = {};
  let next = 0, done = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try { out[id] = infoFrom(await json<RawCard>(f, `${TCGDEX}/cards/${encodeURIComponent(id)}`)); } catch { out[id] = {}; }
      onProgress(++done, ids.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  return out;
}

export interface SearchHit { id: string; setId: string; localId: string; name: string; image?: string }

export async function searchCards(name: string, f: Fetch = fetch): Promise<SearchHit[]> {
  const raw = await json<{ id: string; localId: string; name: string; image?: string }[]>(f, `${TCGDEX}/cards?name=${encodeURIComponent(name)}`);
  return raw.map((c) => ({ ...c, setId: c.id.slice(0, c.id.length - c.localId.length - 1) }));
}

/** TCGdex ids for the bundled 30th Celebration set (prices and images from the database). */
export function tcgdexIdFor30th(cardId: string): string | undefined {
  if (/^\d{3}$/.test(cardId)) return `30th-${cardId}`;
  const m = cardId.match(/^cl-(\d+)$/);
  return m ? `30th-c-${m[1].padStart(3, "0")}` : undefined;
}

// ---------- cache ----------
const ckey = (setId: string) => `setkeeper:v1:catalog:${setId}`;
export function loadCatalog(setId: string): CatalogCache | undefined {
  try { const raw = localStorage.getItem(ckey(setId)); return raw ? (JSON.parse(raw) as CatalogCache) : undefined; } catch { return undefined; }
}
export function saveCatalog(c: CatalogCache) {
  try { localStorage.setItem(ckey(c.set.id), JSON.stringify(c)); } catch { /* quota */ }
}
export function loadSetList(): { sets: SetSummary[]; series: Record<string, string>; at: number } | undefined {
  try { const raw = localStorage.getItem("setkeeper:v1:setlist"); return raw ? JSON.parse(raw) : undefined; } catch { return undefined; }
}
export function saveSetList(v: { sets: SetSummary[]; series: Record<string, string> }) {
  try { localStorage.setItem("setkeeper:v1:setlist", JSON.stringify({ ...v, at: Date.now() })); } catch { /* quota */ }
}
