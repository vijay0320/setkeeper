// Works out which Pokémon card (any English set) a shop or eBay listing title refers to,
// using the full TCGdex card list. Titles look like:
//   "Umbreon ex - 161/131 - Prismatic Evolutions"   "Charizard ex (199/165) [Scarlet & Violet: 151]"
//   "Iono - 237/091 - Special Illustration Rare"     "Pikachu TG05/TG30 Lost Origin Trainer Gallery"
// A listing counts only when its number AND the card's name agree, and, if several sets share
// that number and name, the set's name appears in the title or the shop's tags. Anything still
// ambiguous is skipped rather than guessed.

export interface CatalogCard { id: string; localId: string; name: string; setId: string }
export interface CatalogSet { id: string; name: string; official: number; total: number }

export const EXCLUDE = /\b(psa|bgs|cgc|tag|ace grading|graded|slab|proxy|custom|orica|replica|fake|japanese|jpn|korean|chinese|lot of|bundle|empty|code card|online code|booster|etb|elite trainer|tin|box|pack|sleeves?|binder|playmat|deck box|display|case)\b/i;
export const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const SUFFIX = new Set(["ex", "gx", "v", "vmax", "vstar", "lv", "x", "break", "prime", "legend", "the", "of", "and", "s"]);
/** Words of a card's name that must appear in a title ("Umbreon ex" → ["umbreon"]). */
export const nameWords = (name: string) => {
  const all = norm(name.replace(/\(.*?\)/g, " ").replace(/[♀♂]/g, " ")).split(" ").filter(Boolean);
  const w = all.filter((x) => x.length > 1 && !SUFFIX.has(x));
  return w.length ? w : all; // one-letter names like "N"
};
const setWords = (name: string) => norm(name.replace(/^(scarlet & violet|sword & shield|sun & moon|mega evolution)\s*[—–:-]?\s*/i, "")).split(" ").filter((w) => w.length > 2 && !["the", "and", "pokemon", "tcg"].includes(w));

export interface CardIndex { byNumber: Map<string, CatalogCard[]>; sets: Map<string, CatalogSet> }

const numKey = (left: string, right: string) => {
  const l = left.toUpperCase(), r = right.toUpperCase();
  return /^\d+$/.test(l) && /^\d+$/.test(r) ? `${Number(l)}/${Number(r)}` : `${l.replace(/^([A-Z]+)0*/, "$1")}/${r.replace(/^([A-Z]+)0*/, "$1")}`;
};

/** Index every card by "number/set size" as printed on the card. */
export function buildIndex(cards: CatalogCard[], sets: CatalogSet[]): CardIndex {
  const S = new Map(sets.map((s) => [s.id, s]));
  const byNumber = new Map<string, CatalogCard[]>();
  const add = (k: string, c: CatalogCard) => { const l = byNumber.get(k); if (l) l.push(c); else byNumber.set(k, [c]); };
  // subsets like TG01/TG30, GG01/GG70: the printed size is the subset's own count
  const subsetSize = new Map<string, number>();
  for (const c of cards) { const m = c.localId.match(/^([A-Z]+)(\d+)$/i); if (m) { const k = `${c.setId}|${m[1].toUpperCase()}`; subsetSize.set(k, Math.max(subsetSize.get(k) ?? 0, Number(m[2]))); } }
  for (const c of cards) {
    const s = S.get(c.setId);
    if (!s) continue;
    if (/^\d+$/.test(c.localId) && s.official > 0) add(numKey(c.localId, String(s.official)), c);
    const m = c.localId.match(/^([A-Z]+)(\d+)$/i);
    if (m) add(numKey(c.localId, `${m[1]}${subsetSize.get(`${c.setId}|${m[1].toUpperCase()}`)}`), c);
  }
  return { byNumber, sets: S };
}

export interface Match { card?: CatalogCard; reason?: "excluded" | "no number" | "no card" | "name differs" | "ambiguous" }

/** The card a listing title refers to. `extra` is other text the shop gives (tags, product type). */
export function matchCard(title: string, idx: CardIndex, extra = ""): Match {
  if (EXCLUDE.test(title)) return { reason: "excluded" };
  const t = norm(title), hint = norm(`${title} ${extra}`);
  let sawNumber = false, sawCard = false, named: CatalogCard[] = [];
  for (const m of title.matchAll(/(?:^|[^A-Za-z0-9])([A-Z]{0,4}\d{1,3})\s*\/\s*([A-Z]{0,4}\d{1,3})(?![A-Za-z0-9])/gi)) {
    sawNumber = true;
    const cands = idx.byNumber.get(numKey(m[1], m[2])) ?? [];
    if (cands.length) sawCard = true;
    named = cands.filter((c) => { const w = nameWords(c.name); return w.length > 0 && w.every((x) => t.split(" ").includes(x)); });
    if (named.length) break;
  }
  if (!sawNumber) return { reason: "no number" };
  if (!named.length) return { reason: sawCard ? "name differs" : "no card" };
  if (named.length === 1) return { card: named[0] };
  // "Charizard ex 006/165" (151) vs "Charizard 6/165" (Expedition): the ex/GX/V suffix decides
  const tags = (x: string) => ["ex", "gx", "v", "vmax", "vstar", "break", "prime", "legend"].filter((k) => x.split(" ").includes(k)).join(",");
  const sameTags = named.filter((c) => tags(norm(c.name)) === tags(t));
  if (sameTags.length === 1) return { card: sameTags[0] };
  if (sameTags.length > 1) named = sameTags;
  // several sets print this number with this name: the set's name decides
  // the longest set name found in the text wins ("Base Set 2" over "Base Set")
  const words = ` ${hint} `;
  const score = (c: CatalogCard) => {
    const s = idx.sets.get(c.setId);
    if (!s) return 0;
    const full = norm(s.name);
    if (full && words.includes(` ${full} `)) return 1000 + full.length;
    const w = setWords(s.name);
    return w.length > 0 && w.every((x) => words.includes(` ${x} `)) ? w.join(" ").length : 0;
  };
  const scored = named.map((c) => ({ c, s: score(c) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  return scored.length && (scored.length === 1 || scored[0].s > scored[1].s) ? { card: scored[0].c } : { reason: "ambiguous" };
}

/** Where a card lives in the app: the bundled 30th Celebration set uses its own ids. */
export function appCard(c: CatalogCard): { setId: string; cardId: string } {
  if (c.setId === "30th") return { setId: "30th-celebration", cardId: c.localId.padStart(3, "0") };
  if (c.setId === "30th-c") return { setId: "30th-celebration", cardId: `cl-${String(Number(c.localId)).padStart(2, "0")}` };
  return { setId: c.setId, cardId: c.id };
}
