// Works out which Pokémon card (any English set) a shop or eBay listing title refers to,
// using the full TCGdex card list. Shops write cards in several ways, tried in this order:
//   number/size      "Umbreon ex - 161/131 - Prismatic Evolutions"   "Pikachu TG05/TG30"   "Swablu GG27/70"
//   set code         "Umbreon ★ [POP5-17]"   "Charizard ex [sv035-006]"   "Dugtrio [base1U-19]"
//   promo code       "Lucario VSTAR (SWSH291)"   "Mew ex (SVP053)"   "Gyarados (XY60)"
//   number + set     "Snorlax (051) [Scarlet & Violet: Black Star Promos]"   "Bloodmoon Ursaluna ex (168)"
// A listing counts only when the card's name agrees too, and when several cards still fit, the
// ex/GX/V suffix and then the set's name (in the title, tags or the shop's collection) decide.
// Anything still ambiguous is skipped rather than guessed.

export interface CatalogCard { id: string; localId: string; name: string; setId: string }
export interface CatalogSet { id: string; name: string; official: number; total: number }

export const EXCLUDE = /\b(psa|bgs|cgc|tag|ace grading|graded|slab|proxy|custom|orica|replica|fake|japanese|jpn|korean|chinese|lot of|bundle|empty|code card|online code|booster|etb|elite trainer|tin|box|pack|sleeves?|binder|playmat|deck box|display|case)\b/i;
/** Graded slabs written the way some shops do: "… - HOLO - NM-MT 8", "… - GEM MT 10", "… - EX 5". */
export const GRADED = /\s-\s(gem\s*mt|gem\s*mint|pristine|mint|nm[\s-]*mt|nm|ex[\s-]*mt|ex|vg[\s-]*ex|vg|good|fair|poor|pr|mnt\s*fair|authentic)\s*\+?\s*\d{1,2}(\.5)?\s*$/i;
export const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const SUFFIX = new Set(["ex", "gx", "v", "vmax", "vstar", "lv", "x", "break", "prime", "legend", "the", "of", "and", "s", "basic"]);
/** Words of a card's name that must appear in a title ("Umbreon ex" → ["umbreon"], "Basic Lightning Energy" → ["lightning", "energy"]). */
export const nameWords = (name: string) => {
  const all = norm(name.replace(/\(.*?\)/g, " ").replace(/[♀♂]/g, " ")).split(" ").filter(Boolean);
  const w = all.filter((x) => x.length > 1 && !SUFFIX.has(x));
  return w.length ? w : all; // one-letter names like "N"
};
// words that don't identify a set ("Silver Tempest Trainer Gallery" is found by "Silver Tempest")
const SET_NOISE = new Set(["the", "and", "pokemon", "tcg", "trainer", "gallery", "galarian", "shiny", "vault", "base", "set", "series", "expansion", "black", "star", "promos", "promo", "cards"]);
const setWords = (name: string) => norm(name.replace(/^(scarlet & violet|sword & shield|sun & moon|mega evolution)\s*[—–:-]?\s*/i, "")).split(" ").filter((w) => w.length > 2 && !SET_NOISE.has(w));

export interface CardIndex {
  byNumber: Map<string, CatalogCard[]>; // "161/131", "TG5/TG30"
  byLocal: Map<string, CatalogCard[]>; // "168", "SWSH291": the number alone
  byId: Map<string, CatalogCard>;
  byPromo: Map<string, CatalogCard[]>; // "SVP53", "SWSH291", "XY60"
  sets: Map<string, CatalogSet>;
}

const localKey = (id: string) => { const m = id.toUpperCase().match(/^([A-Z]*)0*(\d+)([A-Z]?)$/); return m ? `${m[1]}${m[2]}${m[3]}` : id.toUpperCase(); };
const numKey = (left: string, right: string) => {
  const l = left.toUpperCase(), r = right.toUpperCase();
  if (/^\d+$/.test(l) && /^\d+$/.test(r)) return `${Number(l)}/${Number(r)}`;
  // "GG27/70": the size is the subset's, written without its letters
  const pre = l.match(/^[A-Z]+/)?.[0] ?? "";
  return `${localKey(l)}/${localKey(/^\d+$/.test(r) ? pre + r : r)}`;
};
const add = <T>(m: Map<string, T[]>, k: string, v: T) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };

/** Promo sets' codes: Scarlet & Violet promos are printed "SVP 053", Mega Evolution "MEP 001". */
const PROMO_PREFIX: Record<string, string> = { svp: "SVP", mep: "MEP" };

/** Index every card by the ways it's printed and written. */
export function buildIndex(cards: CatalogCard[], sets: CatalogSet[]): CardIndex {
  const S = new Map(sets.map((s) => [s.id, s]));
  const byNumber = new Map<string, CatalogCard[]>(), byLocal = new Map<string, CatalogCard[]>(), byPromo = new Map<string, CatalogCard[]>();
  const byId = new Map(cards.map((c) => [c.id.toLowerCase(), c]));
  // subsets like TG01/TG30, GG01/GG70: the printed size is the subset's own count
  const subsetSize = new Map<string, number>();
  for (const c of cards) { const m = c.localId.match(/^([A-Z]+)(\d+)$/i); if (m) { const k = `${c.setId}|${m[1].toUpperCase()}`; subsetSize.set(k, Math.max(subsetSize.get(k) ?? 0, Number(m[2]))); } }
  for (const c of cards) {
    const s = S.get(c.setId);
    if (!s) continue;
    add(byLocal, localKey(c.localId), c);
    if (/^\d+$/.test(c.localId) && s.official > 0) add(byNumber, numKey(c.localId, String(s.official)), c);
    const m = c.localId.match(/^([A-Z]+)(\d+)$/i);
    if (m) add(byNumber, numKey(c.localId, `${m[1]}${subsetSize.get(`${c.setId}|${m[1].toUpperCase()}`)}`), c);
    // some subsets print the main set's size instead: Radiant Collection "RC22/113"
    if (m && s.official > 0) add(byNumber, numKey(c.localId, String(s.official)), c);
    if (/promo/i.test(s.name) || PROMO_PREFIX[s.id]) {
      if (m) add(byPromo, localKey(c.localId), c);
      else if (/^\d+$/.test(c.localId) && PROMO_PREFIX[s.id]) add(byPromo, `${PROMO_PREFIX[s.id]}${Number(c.localId)}`, c);
    }
  }
  return { byNumber, byLocal, byId, byPromo, sets: S };
}

/** TCGdex set ids a shop's set code may mean: "POP5" → pop5, "sv035" → sv03.5, "base1U" → base1, "SV3pt5" → sv03.5. */
export function setCodeVariants(code: string): string[] {
  const c = code.toLowerCase();
  const out = new Set<string>([c]);
  const strip = c.replace(/(u|1e|1st|un|ul)$/, "");
  out.add(strip);
  for (const x of [c, strip]) {
    out.add(x.replace(/pt(\d)$/, ".$1"));
    const m = x.match(/^([a-z]+)(\d+)(?:pt|\.)?(\d)?([a-z]*)$/);
    if (m) {
      const [, p, n, half, tail] = m;
      for (const num of [n, n.padStart(2, "0"), String(Number(n))]) {
        out.add(`${p}${num}${half ? `.${half}` : ""}${tail}`);
        // "sv035": three digits where the last is the half
        if (!half && num.length === 3) out.add(`${p}${num.slice(0, 2)}.${num.slice(2)}${tail}`);
        if (!half && num.length === 3) out.add(`${p}${Number(num.slice(0, 2))}.${num.slice(2)}${tail}`);
      }
    }
  }
  return [...out];
}

export interface Match { card?: CatalogCard; reason?: "excluded" | "no number" | "no card" | "name differs" | "ambiguous" }

/** The card a listing title refers to. `extra` is other text the shop gives (tags, product type, collection). */
export function matchCard(title: string, idx: CardIndex, extra = ""): Match {
  if (EXCLUDE.test(title) || GRADED.test(title)) return { reason: "excluded" };
  const t = norm(title), tw = new Set(t.split(" ")), hint = norm(`${title} ${extra}`);
  const named = (cs: CatalogCard[]) => cs.filter((c) => { const w = nameWords(c.name); return w.length > 0 && w.every((x) => tw.has(x)); });
  let sawNumber = false, sawCard = false;

  // 1. number/size as printed
  for (const m of title.matchAll(/(?:^|[^A-Za-z0-9])([A-Z]{0,4}\d{1,3})\s*\/\s*([A-Z]{0,4}\d{1,3})(?![A-Za-z0-9])/gi)) {
    sawNumber = true;
    const cands = idx.byNumber.get(numKey(m[1], m[2])) ?? [];
    if (cands.length) sawCard = true;
    const n = named(cands);
    if (n.length) return decide(n, t, hint, idx);
  }
  // 2. a set code with the card number: [POP5-17], [sv035-006], [swsh10tg-TG05]
  for (const m of title.matchAll(/(?:^|[\s[(])([A-Za-z]{1,6}\d{0,3}(?:pt\d)?[A-Za-z]{0,3})-([A-Za-z]{0,4}\d{1,3}[A-Za-z]?)(?![A-Za-z0-9])/g)) {
    sawNumber = true;
    for (const set of setCodeVariants(m[1])) {
      if (!idx.sets.has(set)) continue;
      const local = m[2];
      for (const l of new Set([local, local.toUpperCase(), String(Number(local)), local.padStart(3, "0"), local.toUpperCase().replace(/^([A-Z]+)(\d)$/, "$10$2")])) {
        const c = idx.byId.get(`${set}-${l}`.toLowerCase());
        if (!c) continue;
        sawCard = true;
        if (named([c]).length) return { card: c };
      }
    }
  }
  // 2b. a number then the set's code: "Ceruledge ex 36 - SV08 Surging Sparks"
  for (const m of title.matchAll(/(?:^|\s)([A-Z]{0,3}\d{1,3})\s-\s([A-Za-z]{1,5}\d{1,3}(?:\.\d|pt\d)?[a-z]?)(?![A-Za-z0-9])/g)) {
    sawNumber = true;
    for (const set of setCodeVariants(m[2])) {
      if (!idx.sets.has(set)) continue;
      for (const l of new Set([m[1], String(Number(m[1])), m[1].padStart(3, "0")])) {
        const c = idx.byId.get(`${set}-${l}`.toLowerCase());
        if (!c) continue;
        sawCard = true;
        if (named([c]).length) return { card: c };
      }
    }
  }
  // 3. promo codes: SVP053, SWSH291, XY60, SM228, BW93
  for (const m of title.matchAll(/(?:^|[^A-Za-z0-9])(SVP|MEP|SWSH|SM|XY|BW|DP|HGSS|NP)\s?-?\s?(\d{1,3})(?![0-9])/gi)) {
    sawNumber = true;
    const cands = idx.byPromo.get(`${m[1].toUpperCase()}${Number(m[2])}`) ?? [];
    if (cands.length) sawCard = true;
    const n = named(cands);
    if (n.length) return decide(n, t, hint, idx);
  }
  // 4. a lone number, "(168)" or "- 051": the name, then the set's name, must single it out
  for (const m of title.matchAll(/(?:\(|#|\s-\s|\s)\s*([A-Z]{0,4}\d{1,3})\s*(?:\)|\s-\s|$)/gi)) {
    sawNumber = true;
    const cands = idx.byLocal.get(localKey(m[1])) ?? [];
    if (cands.length) sawCard = true;
    const n = named(cands);
    if (n.length) {
      // with no size printed, a promo set is likely when the title says so
      const promo = /promo/.test(hint) ? n.filter((c) => /promo/i.test(idx.sets.get(c.setId)?.name ?? "")) : [];
      return decide(promo.length ? promo : n, t, hint, idx, true);
    }
  }
  if (!sawNumber) return { reason: "no number" };
  return { reason: sawCard ? "name differs" : "no card" };
}

/** Several cards fit the number and name: the ex/GX/V suffix, then the set's name, decide. */
function decide(named: CatalogCard[], t: string, hint: string, idx: CardIndex, needSet = false): Match {
  if (named.length === 1 && !needSet) return { card: named[0] };
  // "Charizard ex 006/165" (151) vs "Charizard 6/165" (Expedition)
  const tags = (x: string) => ["ex", "gx", "v", "vmax", "vstar", "break", "prime", "legend"].filter((k) => x.split(" ").includes(k)).join(",");
  const same = named.filter((c) => tags(norm(c.name)) === tags(t));
  if (same.length === 1 && !needSet) return { card: same[0] };
  if (same.length) named = same;
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
  if (scored.length && (scored.length === 1 || scored[0].s > scored[1].s)) return { card: scored[0].c };
  // a lone number with no set named can only stand when exactly one card has that name and number
  if (needSet && named.length === 1) return { card: named[0] };
  return { reason: "ambiguous" };
}

/** Where a card lives in the app: the bundled 30th Celebration set uses its own ids. */
export function appCard(c: CatalogCard): { setId: string; cardId: string } {
  if (c.setId === "30th") return { setId: "30th-celebration", cardId: c.localId.padStart(3, "0") };
  if (c.setId === "30th-c") return { setId: "30th-celebration", cardId: `cl-${String(Number(c.localId)).padStart(2, "0")}` };
  return { setId: c.setId, cardId: c.id };
}
