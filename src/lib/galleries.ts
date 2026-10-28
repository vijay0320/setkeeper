// The official Pokémon TCG card galleries (tcg.pokemon.com/en-us/all-galleries/).
// Each gallery lists every card in an expansion by number, grouped into the official
// categories (Special Art, Pokémon ex, Hyper Rare…), with card images on Pokémon's CDN.
// The gallery has no card names, so names, rarities and prices come from TCGdex when
// the set is there; a set too new for TCGdex still gets a binder from the gallery alone.
// data/galleries/index.json is refreshed daily by scripts/gallery-scout.ts.
import type { Card, CardSet } from "./types.ts";

export interface GalleryPart {
  version: string; // "cards", or e.g. "zsv-cards" when one gallery holds two sets
  label?: string; // e.g. "Black Bolt"
  count: number;
  tcgdex: string | null; // matching TCGdex set id once the database has the set
  categories: Record<string, string>; // filter key → card numbers as ranges, e.g. "1-3,7"
}
export interface Gallery {
  slug: string;
  name: string;
  code: string;
  galleryId: string;
  assetPath: string;
  logo?: string;
  firstSeen: string;
  filters: Record<string, string>; // filter key → label
  parts: GalleryPart[];
}
export interface GalleryIndex { checkedAt: string; source: string; note?: string; imageHost: string; galleries: Gallery[] }

// ---------- number ranges ----------
export function parseRanges(s: string): number[] {
  const out: number[] = [];
  for (const bit of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = bit.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    for (let i = a; i <= b; i++) out.push(i);
  }
  return out;
}
export function toRanges(ns: number[]): string {
  const xs = [...new Set(ns)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < xs.length; i++) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    out.push(j > i ? `${xs[i]}-${xs[j]}` : String(xs[i]));
    i = j;
  }
  return out.join(",");
}

// ---------- naming ----------
/** "Pokémon TCG: Scarlet & Violet—Surging Sparks" → "Surging Sparks". */
export function shortName(name: string): string {
  return name.replace(/^Pok.mon TCG:\s*/i, "").replace(/^(Scarlet & Violet|Mega Evolution|Sword & Shield|Sun & Moon)\s*[^\w\s&]\s*/i, "").trim();
}
export function seriesOf(g: Gallery): string {
  const m = g.name.match(/^Pok.mon TCG:\s*(Scarlet & Violet|Mega Evolution|Sword & Shield|Sun & Moon)/i);
  return m ? m[1] : g.assetPath.startsWith("me") ? "Mega Evolution" : g.assetPath.startsWith("sv") ? "Scarlet & Violet" : "";
}
export const partName = (g: Gallery, p: GalleryPart) => p.label ?? shortName(g.name);
export const galleryUrl = (g: Gallery) => `https://tcg.pokemon.com/en-us/galleries/${g.slug}/`;
/** Set id used by the app: the TCGdex id once known, otherwise a gallery id. */
export const gallerySetId = (g: Gallery, p: GalleryPart) => `gallery:${g.slug}${g.parts.length > 1 ? `:${p.version}` : ""}`;

/** The official card image (same pattern the gallery page uses). */
export function officialImage(host: string, g: Gallery, p: GalleryPart, n: number, category?: string): string {
  const classic = category === "classic-collection" ? "_Classic" : "";
  const ver = p.version === "cards" ? "" : `_${p.version.replace("-cards", "").toUpperCase()}`;
  return `${host}${g.slug}/en-us/${g.galleryId}${classic}${ver}_EN_${n}.png`;
}

/** Most specific category first: a card that is both "ex" and "Special Art" goes under Special Art. */
const SECTION_ORDER = ["hyper-rare", "special-art", "alt-art", "futuristic-rare", "shiny", "ace-spec", "pikachu-rare", "mega-evolution-pokemon",
  "type-shifted", "tera-ex", "tera", "ex", "pokemon-ex", "ancient-future", "paradox", "trainers-pokemon", "trainers", "first"];
const IGNORE = new Set(["seeall", "gen-9", "paldea", "abil", "classic-collection"]);
export function sectionFor(p: GalleryPart, filters: Record<string, string>, n: number, sets = categorySets(p)): string {
  const keys = [...SECTION_ORDER, ...Object.keys(p.categories)].filter((k, i, a) => a.indexOf(k) === i && !IGNORE.has(k));
  for (const k of keys) if (sets[k]?.has(n)) return filters[k] ?? k;
  return "Main Set";
}
export function categorySets(p: GalleryPart): Record<string, Set<number>> {
  return Object.fromEntries(Object.entries(p.categories).map(([k, v]) => [k, new Set(parseRanges(v))]));
}

interface DbCard { id: string; localId: string; name: string; image?: string }
export interface DbSet { id: string; name: string; releaseDate?: string; logo?: string; serie?: { name: string }; cardCount?: { official: number }; cards: DbCard[] }

/**
 * Build the app's set from a gallery part. With TCGdex data, card ids are TCGdex ids (so
 * existing binders and prices keep working) and names come from the database; without
 * it, cards are numbered and named "Card 012" until the database catches up.
 */
export function gallerySet(host: string, g: Gallery, p: GalleryPart, db?: DbSet, setId?: string): CardSet {
  const sets = categorySets(p);
  const byNum = new Map<number, DbCard>();
  for (const c of db?.cards ?? []) if (/^\d+$/.test(c.localId)) byNum.set(Number(c.localId), c);
  const official = db?.cardCount?.official || p.count;
  const width = Math.max(3, String(p.count).length);
  const id = setId ?? db?.id ?? gallerySetId(g, p);
  // a binder started before TCGdex had the set keeps its gallery card ids, so nothing is lost
  // TCGdex card ids are "<set>-<number>", so a TCGdex-backed set keeps the same ids even if the database was unreachable
  const dbIds = !id.startsWith("gallery:");
  const cards: Card[] = [];
  for (let n = 1; n <= p.count; n++) {
    const c = byNum.get(n);
    const num = String(n).padStart(width, "0");
    cards.push({
      id: dbIds ? (c?.id ?? `${id}-${num}`) : `g-${num}`,
      ...(c && !dbIds ? { ref: c.id } : {}),
      section: sectionFor(p, g.filters, n, sets),
      number: `${num}/${String(official).padStart(width, "0")}`,
      name: c?.name ?? `Card ${num}`,
      rarity: "Unknown",
      // TCGdex images can be used in 3D (CORS); the official CDN only in plain <img>
      image: c?.image ?? officialImage(host, g, p, n),
    });
  }
  // TCGdex cards the gallery doesn't show (rare: promos stapled onto a set) are kept at the end
  for (const c of db?.cards ?? []) if (!cards.some((x) => x.id === c.id || x.ref === c.id)) cards.push({ id: dbIds ? c.id : `g-${c.localId}`, ...(dbIds ? {} : { ref: c.id }), section: "Other", number: c.localId, name: c.name, rarity: "Unknown", ...(c.image ? { image: c.image } : {}) });
  const order = [...SECTION_ORDER.map((k) => g.filters[k] ?? k), "Main Set", "Other"];
  const sections = [...new Set(cards.map((c) => c.section))].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (a === "Main Set" ? -1 : ia < 0 ? 99 : ia) - (b === "Main Set" ? -1 : ib < 0 ? 99 : ib);
  });
  return {
    id, name: db?.name ?? partName(g, p), series: db?.serie?.name ?? seriesOf(g), language: "en", releaseDate: db?.releaseDate ?? "",
    imageBase: "", imageSuffix: "", sections, rarities: ["Unknown"], cards,
    sources: [galleryUrl(g), ...(db ? [`https://tcgdex.dev (set ${db.id})`] : [])],
    ...(db?.logo ? { logo: db.logo } : {}),
  } as CardSet;
}

/** Find the gallery part for an app set id (TCGdex id or gallery id). */
export function findPart(idx: GalleryIndex, setId: string): { g: Gallery; p: GalleryPart } | undefined {
  for (const g of idx.galleries) for (const p of g.parts) if (p.tcgdex === setId || gallerySetId(g, p) === setId) return { g, p };
  return undefined;
}

// ---------- parsing the official pages (used by the scout) ----------
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#8212;|&mdash;/g, "—").replace(/&#8217;|&rsquo;/g, "’").replace(/&eacute;/g, "é").replace(/&#233;/g, "é").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const strip = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** All-galleries page → gallery slugs with names and logos, newest first as listed. */
export function parseIndexPage(html: string): { slug: string; name: string; logo?: string }[] {
  const out = new Map<string, { slug: string; name: string; logo?: string }>();
  for (const m of html.matchAll(/<a\b[^>]*href="[^"]*\/galleries\/([a-z0-9-]+)\/?"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const [, slug, inner] = m;
    const name = strip(inner);
    const logo = inner.match(/<img[^>]+src="([^"]+)"/i)?.[1];
    const o = out.get(slug) ?? { slug, name };
    if (name && name.length > o.name.length) o.name = name;
    if (logo) o.logo = logo;
    out.set(slug, o);
  }
  return [...out.values()].filter((g) => g.name);
}

export interface GalleryPage {
  code?: string;
  title?: string;
  roots: { expansion: string; expansionId: string; assetPath: string }[];
  filters: Record<string, string>;
  scripts: string[];
}
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1];
/** One gallery page → expansion id, asset folder, category labels and custom scripts. */
export function parseGalleryPage(html: string): GalleryPage {
  const body = html.match(/<body\b[^>]*>/i)?.[0] ?? "";
  const roots = [...html.matchAll(/<[a-z]+\b[^>]*data-controller="GalleryCards"[^>]*>/gi)].map((m) => ({
    expansion: attr(m[0], "data-expansion") ?? "", expansionId: attr(m[0], "data-expansion-id") ?? "",
    assetPath: attr(m[0], "data-expansion-asset-path") ?? "expansions",
  })).filter((r) => r.expansion && r.expansionId);
  const filters: Record<string, string> = {};
  for (const m of html.matchAll(/<[a-z]+\b[^>]*data-controller="CardGalleryButton"[^>]*>/gi)) {
    const k = attr(m[0], "data-filter"), v = attr(m[0], "data-track-filter");
    if (k) filters[k] = decode(v ?? k);
  }
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]*galleries\/[^"]+\.js)"/gi)].map((m) => m[1]).filter((s) => !/\/galleries\/gallery\.js$/.test(s));
  return { code: attr(body, "data-tracking-expansion-name"), title: strip(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? ""), roots, filters, scripts };
}
/** Card versions a custom gallery script asks for, e.g. two sets on one page. */
export function versionsFromScript(js: string): string[] {
  return [...new Set([...js.matchAll(/expCardVersion:\s*"([a-z0-9-]+)"/gi)].map((m) => m[1]))];
}
/** Expansion ids whose card lists live under the id rather than the slug (from gallery.js). */
export function idFoldersFromScript(js: string): string[] {
  const m = js.match(/\[\s*"SV01"[^\]]*\]/);
  if (!m) return [];
  try { return JSON.parse(m[0]); } catch { return []; }
}
export function cardsJsonPath(root: { expansion: string; expansionId: string; assetPath: string }, version: string, idFolders: string[]): string {
  const folder = idFolders.includes(root.expansionId) ? root.expansionId.toLowerCase() : root.expansion;
  return `/assets/img/${root.assetPath}/${folder}/cards/${version.toLowerCase()}.json`;
}
/** cards.json → part (count from "seeall", other categories as ranges). */
export function partFrom(version: string, json: Record<string, number[]>, label?: string): Omit<GalleryPart, "tcgdex"> {
  const all = json.seeall ?? [...new Set(Object.values(json).flat())];
  const categories: Record<string, string> = {};
  for (const [k, v] of Object.entries(json)) if (k !== "seeall" && Array.isArray(v) && v.length) categories[k] = toRanges(v);
  return { version, ...(label ? { label } : {}), count: Math.max(0, ...all), categories };
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** Match a gallery part to a TCGdex set by name (e.g. "Surging Sparks", "Black Bolt"). */
export function matchTcgdex(name: string, sets: { id: string; name: string }[]): string | null {
  const n = norm(name);
  return sets.find((s) => norm(s.name) === n)?.id ?? null;
}

/** Merge a fresh scrape into the saved index: keeps first-seen dates and known TCGdex ids. */
export function mergeIndex(prev: GalleryIndex | undefined, next: Gallery[], today: string): { index: GalleryIndex; added: string[]; changed: string[] } {
  const old = new Map((prev?.galleries ?? []).map((g) => [g.slug, g]));
  const added: string[] = [], changed: string[] = [];
  const galleries = next.map((g) => {
    const o = old.get(g.slug);
    if (!o) { added.push(g.slug); return { ...g, firstSeen: today }; }
    const parts = g.parts.map((p) => ({ ...p, tcgdex: p.tcgdex ?? o.parts.find((q) => q.version === p.version)?.tcgdex ?? null }));
    const merged = { ...g, firstSeen: o.firstSeen, parts };
    if (JSON.stringify(merged) !== JSON.stringify(o)) changed.push(g.slug);
    return merged;
  });
  // a gallery that disappears from the index page is kept (Pokémon rotates the list)
  for (const o of old.values()) if (!galleries.some((g) => g.slug === o.slug)) galleries.push(o);
  return { index: { checkedAt: today, source: prev?.source ?? "https://tcg.pokemon.com/en-us/all-galleries/", note: prev?.note, imageHost: prev?.imageHost ?? "https://dz3we2x72f7ol.cloudfront.net/expansions/", galleries }, added, changed };
}
