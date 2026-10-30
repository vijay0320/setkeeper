// Fair prices that compare like with like.
//
// A card's price depends on two things besides the card itself:
//   - its printing: Normal, Holofoil, Reverse Holofoil, 1st Edition… are different products
//     with different prices (TCGdex gives TCGplayer prices for each printing separately);
//   - its condition: NM, LP, MP, HP, DMG. The free price sources only price Near Mint, so
//     other conditions are NM × a condition factor. Factors start as labelled estimates and
//     are replaced by factors measured from real Canadian shop listings once there are
//     enough of them (scripts/scout.ts → data/prices/conditions.json).
//
// Sources disagree (TCGplayer "market" runs ~20% above eBay sold and Cardmarket), so a
// price is shown as a fair value with the range of the sources behind it, never one
// unexplained number. The same fair-value rule is used in SQL (supabase/setup.sql,
// cards_total_by_day): mean of the sources that have a price.

export type Condition = "NM" | "LP" | "MP" | "HP" | "DMG";
export const CONDITIONS: Condition[] = ["NM", "LP", "MP", "HP", "DMG"];
export const CONDITION_NAME: Record<Condition, string> = {
  NM: "Near Mint", LP: "Lightly Played", MP: "Moderately Played", HP: "Heavily Played", DMG: "Damaged",
};

/** Printings as TCGdex/TCGplayer name them. */
export const PRINTING_LABEL: Record<string, string> = {
  normal: "Normal",
  holofoil: "Holofoil",
  "reverse-holofoil": "Reverse Holofoil",
  "1st-edition": "1st Edition",
  "1st-edition-holofoil": "1st Edition Holofoil",
  "1st-edition-normal": "1st Edition",
  unlimited: "Unlimited",
  "unlimited-holofoil": "Unlimited Holofoil",
  "unlimited-normal": "Unlimited",
};
export const printingLabel = (p: string) => PRINTING_LABEL[p] ?? p.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
// which printing a card is "normally" priced as when nobody says otherwise
const DEFAULT_ORDER = ["holofoil", "normal", "unlimited-holofoil", "unlimited", "unlimited-normal", "1st-edition-holofoil", "1st-edition", "1st-edition-normal", "reverse-holofoil"];

export interface PrintingPrice {
  printing: string;
  /** TCGplayer, USD: low = cheapest listing (any condition), market = recent sales, mostly NM. */
  tcg?: { low?: number; mid?: number; market?: number; high?: number };
  /** Cardmarket (Europe), EUR. */
  cm?: { low?: number; trend?: number; avg30?: number };
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined;
};
const compact = <T extends object>(o: T): T | undefined => {
  const e = Object.entries(o).filter(([, v]) => v != null);
  return e.length ? (Object.fromEntries(e) as T) : undefined;
};

export interface RawPricing {
  tcgplayer?: Record<string, unknown> | null;
  cardmarket?: Record<string, unknown> | null;
}

/**
 * Every printing's prices from a TCGdex card. Cardmarket has one price for the card plus a
 * "-holo" price for its reverse holo, so the plain one goes to the default printing and the
 * "-holo" one to Reverse Holofoil.
 */
export function pricesFrom(pricing?: RawPricing | null): PrintingPrice[] {
  const out: PrintingPrice[] = [];
  const tp = pricing?.tcgplayer;
  if (tp) {
    for (const [k, v] of Object.entries(tp)) {
      if (!v || typeof v !== "object") continue; // "updated", "unit"
      const x = v as Record<string, unknown>;
      const tcg = compact({ low: num(x.lowPrice), mid: num(x.midPrice), market: num(x.marketPrice), high: num(x.highPrice) });
      if (tcg) out.push({ printing: k, tcg });
    }
  }
  const cm = pricing?.cardmarket;
  if (cm) {
    const g = (k: string) => num(cm[k]);
    const plain = compact({ low: g("low"), trend: g("trend"), avg30: g("avg30") ?? g("avg") });
    const holo = compact({ low: g("low-holo"), trend: g("trend-holo"), avg30: g("avg30-holo") ?? g("avg-holo") });
    const at = (printing: string) => { let p = out.find((x) => x.printing === printing); if (!p) out.push(p = { printing }); return p; };
    if (plain) at(defaultPrinting(out) ?? (out.length ? out[0].printing : "normal")).cm = plain;
    // only attach the holo price where TCGplayer also knows a reverse holo (or there's nothing else)
    if (holo && (out.some((x) => x.printing === "reverse-holofoil") || !plain)) at("reverse-holofoil").cm = holo;
  }
  const rank = (p: string) => { const i = DEFAULT_ORDER.indexOf(p); return i < 0 ? 50 : i; };
  return out.sort((a, b) => rank(a.printing) - rank(b.printing));
}

/** The printing a card is priced as by default: holofoil, else normal, …, reverse holo last. */
export function defaultPrinting(prices: PrintingPrice[]): string | undefined {
  const withPrice = prices.filter((p) => p.tcg || p.cm);
  for (const k of DEFAULT_ORDER) if (withPrice.some((p) => p.printing === k)) return k;
  return withPrice[0]?.printing;
}

export interface Fx { usdcad: number; eurcad: number }
export interface SourcePrice { source: "TCGplayer" | "Cardmarket"; label: string; native: number; currency: "USD" | "EUR"; cad: number }
export interface FairValue {
  printing: string;
  nm: number; // fair Near Mint value, CAD
  low: number; // lowest source, CAD
  high: number; // highest source, CAD
  sources: SourcePrice[];
  /** (high - low) / fair: large means the sources disagree and the collector should check sold listings. */
  spread: number;
  disagree: boolean;
}
export const DISAGREE_AT = 0.35;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Cardmarket's figure for a printing: the mean of its trend and 30-day average (smooths spikes). */
export function cmValue(cm?: PrintingPrice["cm"]): number | undefined {
  if (!cm) return undefined;
  if (cm.trend != null && cm.avg30 != null) return (cm.trend + cm.avg30) / 2;
  return cm.trend ?? cm.avg30;
}

/**
 * Fair Near Mint value of one printing, in CAD: the mean of the sources that price it
 * (TCGplayer market; Cardmarket trend/30-day), with their range.
 * TCGplayer's "low" is the cheapest listing in any condition, so it's never used as a value.
 */
export function fairValue(p: PrintingPrice | undefined, fx: Fx): FairValue | undefined {
  if (!p) return undefined;
  const sources: SourcePrice[] = [];
  const tm = p.tcg?.market ?? p.tcg?.mid;
  if (tm != null) sources.push({ source: "TCGplayer", label: p.tcg?.market != null ? "TCGplayer market (US sales)" : "TCGplayer mid (US listings)", native: tm, currency: "USD", cad: r2(tm * fx.usdcad) });
  const cv = cmValue(p.cm);
  if (cv != null) sources.push({ source: "Cardmarket", label: "Cardmarket trend / 30-day (Europe)", native: r2(cv), currency: "EUR", cad: r2(cv * fx.eurcad) });
  if (!sources.length) return undefined;
  const cads = sources.map((s) => s.cad);
  const nm = r2(cads.reduce((a, b) => a + b, 0) / cads.length);
  const low = Math.min(...cads), high = Math.max(...cads);
  const spread = nm ? (high - low) / nm : 0;
  return { printing: p.printing, nm, low, high, sources, spread, disagree: spread > DISAGREE_AT };
}

// ---------- conditions ----------

/** Starting estimates (share of the NM price), used until real listings say otherwise. */
export const DEFAULT_FACTORS: Record<Condition, number> = { NM: 1, LP: 0.85, MP: 0.7, HP: 0.5, DMG: 0.35 };
/** NM value bands (CAD) used for measured factors: discounts differ for cheap and expensive cards. */
export const BANDS = [{ id: "under10", max: 10 }, { id: "10to100", max: 100 }, { id: "over100", max: Infinity }] as const;
export type Band = (typeof BANDS)[number]["id"];
export const bandOf = (nm: number): Band => BANDS.find((b) => nm < b.max)!.id;
export const MIN_PAIRS = 8;

export interface ObservedFactor { ratio: number; pairs: number }
export interface ConditionData {
  updatedAt?: string;
  /** Measured share of NM per condition, overall and per value band, from shops' own NM vs played prices. */
  overall: Partial<Record<Condition, ObservedFactor>>;
  bands?: Partial<Record<Band, Partial<Record<Condition, ObservedFactor>>>>;
  /** priced "shop-currency": measured from prices in the shop's own currency (runs before Oct 31, 2026 weren't). */
  days?: { day: string; overall: Partial<Record<Condition, ObservedFactor>>; bands?: ConditionData["bands"]; priced?: string }[];
  note?: string;
}

export type FactorBasis = "measured" | "estimate" | "yours";
export interface Factor { factor: number; basis: FactorBasis; pairs?: number }

/** The factor to use for a condition: the collector's own, else measured (enough pairs), else the estimate. */
export function conditionFactor(cond: string | undefined, data?: ConditionData, nm?: number, own?: Partial<Record<Condition, number>>): Factor {
  const c = (CONDITIONS as string[]).includes(cond ?? "") ? (cond as Condition) : "NM";
  if (c === "NM") return { factor: 1, basis: "estimate" };
  const mine = own?.[c];
  if (mine != null && mine > 0 && mine <= 1.2) return { factor: mine, basis: "yours" };
  const band = nm != null ? data?.bands?.[bandOf(nm)]?.[c] : undefined;
  if (band && band.pairs >= MIN_PAIRS) return { factor: band.ratio, basis: "measured", pairs: band.pairs };
  const all = data?.overall?.[c];
  if (all && all.pairs >= MIN_PAIRS) return { factor: all.ratio, basis: "measured", pairs: all.pairs };
  return { factor: DEFAULT_FACTORS[c], basis: "estimate" };
}

export interface ValueFor { value: number; low: number; high: number; factor: Factor; fair: FairValue; condition: Condition }
/** Fair value of a printing in a condition, CAD. */
export function valueFor(fair: FairValue | undefined, condition: string | undefined, data?: ConditionData, own?: Partial<Record<Condition, number>>): ValueFor | undefined {
  if (!fair) return undefined;
  const c = ((CONDITIONS as string[]).includes(condition ?? "") ? condition : "NM") as Condition;
  const f = conditionFactor(c, data, fair.nm, own);
  return { value: r2(fair.nm * f.factor), low: r2(fair.low * f.factor), high: r2(fair.high * f.factor), factor: f, fair, condition: c };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface PricedListing { sellerId: string; cardId: string; printing?: string; condition?: string; cad: number }

/**
 * Measure condition discounts from listings: within one shop, the same card and printing in
 * NM and in a played condition gives one ratio (the shop's own grading and pricing, so shop
 * markups cancel out). The factor is the median ratio across pairs.
 */
export function measureConditions(listings: PricedListing[]): { overall: ConditionData["overall"]; bands: NonNullable<ConditionData["bands"]> } {
  const groups = new Map<string, Map<string, number[]>>();
  for (const l of listings) {
    const c = l.condition ?? "NM";
    if (!(CONDITIONS as string[]).includes(c) || !(l.cad > 0)) continue;
    const k = `${l.sellerId}|${l.cardId}|${l.printing ?? ""}`;
    const g = groups.get(k) ?? new Map<string, number[]>();
    g.set(c, [...(g.get(c) ?? []), l.cad]);
    groups.set(k, g);
  }
  const all: Partial<Record<Condition, number[]>> = {};
  const byBand: Partial<Record<Band, Partial<Record<Condition, number[]>>>> = {};
  for (const g of groups.values()) {
    const nm = g.get("NM");
    if (!nm) continue;
    const nmPrice = Math.min(...nm);
    if (nmPrice < 0.5) continue; // bulk: prices are floors, not discounts
    const band = bandOf(nmPrice);
    for (const c of CONDITIONS) {
      if (c === "NM" || !g.has(c)) continue;
      const ratio = Math.min(...g.get(c)!) / nmPrice;
      if (!(ratio > 0.05 && ratio <= 1.2)) continue; // a mislabelled listing, not a discount
      (all[c] ??= []).push(ratio);
      ((byBand[band] ??= {})[c] ??= []).push(ratio);
    }
  }
  const sum = (m: Partial<Record<Condition, number[]>>) => Object.fromEntries(Object.entries(m).map(([c, rs]) => [c, { ratio: r2(median(rs!)), pairs: rs!.length }])) as Partial<Record<Condition, ObservedFactor>>;
  return { overall: sum(all), bands: Object.fromEntries(Object.entries(byBand).map(([b, m]) => [b, sum(m!)])) as NonNullable<ConditionData["bands"]> };
}

/** Roll today's measurement into the last 30 days and recompute the pair-weighted factors. */
export function rollConditions(prev: ConditionData | undefined, today: string, m: ReturnType<typeof measureConditions>): ConditionData {
  const days = [...(prev?.days ?? []).filter((d) => d.day !== today), { day: today, overall: m.overall, bands: m.bands }]
    .sort((a, b) => a.day.localeCompare(b.day)).slice(-30);
  const combine = (pick: (d: (typeof days)[number]) => Partial<Record<Condition, ObservedFactor>> | undefined) => {
    const out: Partial<Record<Condition, ObservedFactor>> = {};
    for (const c of CONDITIONS) {
      if (c === "NM") continue;
      let w = 0, s = 0;
      for (const d of days) { const f = pick(d)?.[c]; if (f?.pairs) { w += f.pairs; s += f.ratio * f.pairs; } }
      if (w) out[c] = { ratio: r2(s / w), pairs: w };
    }
    return out;
  };
  const bands: NonNullable<ConditionData["bands"]> = {};
  for (const b of BANDS) { const v = combine((d) => d.bands?.[b.id]); if (Object.keys(v).length) bands[b.id] = v; }
  return {
    updatedAt: today, overall: combine((d) => d.overall), bands, days,
    note: "Share of the Near Mint price, measured from shops listing the same card in NM and a played condition (last 30 days, weighted by pairs). Used once a condition has at least 8 pairs; otherwise SetKeeper's estimates apply.",
  };
}

// ---------- daily price rows (scripts/price-history.ts) ----------

/** One card_prices row (supabase/setup.sql). */
export interface PriceRow {
  card_id: string; printing: string; set_id: string; day: string; is_default: boolean;
  tcg_low: number | null; tcg_mid: number | null; tcg_market: number | null; tcg_high: number | null;
  cm_low: number | null; cm_trend: number | null; cm_avg30: number | null;
}

export function priceRows(cardId: string, setId: string, day: string, pricing: RawPricing | null | undefined): PriceRow[] {
  const prices = pricesFrom(pricing);
  const def = defaultPrinting(prices);
  return prices.map((p) => ({
    card_id: cardId, printing: p.printing, set_id: setId, day, is_default: p.printing === def,
    tcg_low: p.tcg?.low ?? null, tcg_mid: p.tcg?.mid ?? null, tcg_market: p.tcg?.market ?? null, tcg_high: p.tcg?.high ?? null,
    cm_low: p.cm?.low ?? null, cm_trend: p.cm?.trend ?? null, cm_avg30: p.cm?.avg30 ?? null,
  }));
}

// ---------- reading printings and conditions from listing text ----------

/** Printing named in a listing title or variant ("Reverse Holo", "1st Edition"…), if any. */
export function printingFromText(s?: string): string | undefined {
  if (!s) return undefined;
  const t = s.toLowerCase();
  const first = /\b1st\s*ed(ition|\.)?\b|\bfirst edition\b/.test(t);
  const nonHolo = /\bnon[\s-]*holo/.test(t), holo = !nonHolo && /\bholo(foil)?\b/.test(t);
  if (/\breverse[\s-]*holo(foil)?\b|\brev\.?\s*holo\b|\bR\/H\b/i.test(s)) return "reverse-holofoil";
  if (first) return holo ? "1st-edition-holofoil" : "1st-edition";
  if (/\bunlimited\b/.test(t)) return holo ? "unlimited-holofoil" : "unlimited";
  if (nonHolo) return "normal";
  if (holo) return "holofoil";
  if (/\bnormal\b/.test(t)) return "normal";
  return undefined;
}

/** Condition named in a listing variant or title. */
export function conditionFromText(s?: string): Condition | undefined {
  if (!s) return undefined;
  const t = s.toLowerCase();
  if (/damag|\bdmg\b|\bpoor\b/.test(t)) return "DMG";
  if (/heavily|\bhp\b|heavy play/.test(t)) return "HP";
  if (/moderately|\bmp\b|\bgood\b/.test(t)) return "MP";
  if (/lightly|\blp\b|\bexcellent\b/.test(t)) return "LP";
  if (/near[\s-]*mint|\bnm\b|\bmint\b/.test(t)) return "NM";
  if (/\bplayed\b/.test(t)) return "MP"; // a bare "Played" is usually the middle grade
  return undefined;
}

/** Which printing a listing is for, given the card's known printings. */
export function listingPrinting(text: string | undefined, known: string[]): string | undefined {
  const p = printingFromText(text);
  if (!p) return undefined;
  if (known.includes(p)) return p;
  // "Holo" on a card that only has e.g. unlimited-holofoil
  if (p === "holofoil") return known.find((k) => k.endsWith("holofoil") && k !== "reverse-holofoil");
  if (p === "normal") return known.find((k) => k === "normal" || k.endsWith("-normal") || k === "unlimited" || k === "1st-edition");
  return p;
}
