// "Worth grading?": expected value of sending a card to PSA vs keeping it raw.
//
// Grade chances start from how the card looks (corners, edges, surface) and are then
// capped by measured centering: a card whose centering only allows a 9 can't get a 10,
// so that probability moves down a grade. The defaults are rough starting points; the
// collector can override them per card once they know their own hit rate.

export type Condition = "pristine" | "minor" | "worn";

export const CONDITION_LABEL: Record<Condition, string> = {
  pristine: "Pack fresh, no flaws I can see",
  minor: "Tiny whitening, a light scratch or print line",
  worn: "Visible wear",
};

/** Chance of PSA 10 / 9 / 8-or-lower before centering is considered. */
export const BASE_ODDS: Record<Condition, [number, number, number]> = {
  pristine: [0.5, 0.38, 0.12],
  minor: [0.12, 0.5, 0.38],
  worn: [0.01, 0.17, 0.82],
};

export interface GradingCosts {
  fee: number; // per card, CAD
  shipping: number; // per card share of shipping + insurance both ways, CAD
}

export interface GradingInput {
  raw: number; // what the card sells for raw, CAD
  psa10: number;
  psa9: number;
  psa8?: number; // defaults to the raw value
  condition: Condition;
  centeringCap?: string; // best PSA grade centering allows, e.g. "10", "9", "8"
  odds?: [number, number, number]; // override
  company?: string; // for wording, e.g. "Beckett"
  gradeName?: (cap: string) => string; // maps a cap ("10"/"9"/"8") to the company's grade name
}

export interface GradingResult {
  odds: [number, number, number]; // after centering
  expected: number; // expected graded sale value
  cost: number;
  profit: number; // expected value − cost − raw value given up
  breakEven10: number | null; // chance of a 10 needed to break even (null if impossible)
  verdict: "grade" | "borderline" | "keep-raw";
  reason: string;
}

const money = (n: number) => n.toLocaleString("en-CA", { style: "currency", currency: "CAD" });

export function applyCentering(odds: [number, number, number], cap?: string): [number, number, number] {
  let [p10, p9, p8] = odds;
  const c = cap ? parseFloat(cap) : 10;
  if (!(c >= 10)) { p9 += p10; p10 = 0; }
  if (!(c >= 9)) { p8 += p9; p9 = 0; }
  return [p10, p9, p8];
}

export function worthGrading(i: GradingInput, costs: GradingCosts): GradingResult {
  const odds = applyCentering(i.odds ?? BASE_ODDS[i.condition], i.centeringCap);
  const v8 = i.psa8 ?? i.raw;
  const expected = odds[0] * i.psa10 + odds[1] * i.psa9 + odds[2] * v8;
  const cost = costs.fee + costs.shipping;
  const profit = expected - cost - i.raw;
  // p10 needed so that p10*psa10 + (1-p10)*(the lower outcomes in the same proportion) = raw + cost
  const rest = odds[1] + odds[2];
  const lower = rest > 0 ? (odds[1] * i.psa9 + odds[2] * v8) / rest : v8;
  const need = i.psa10 > lower ? (i.raw + cost - lower) / (i.psa10 - lower) : null;
  const breakEven10 = need == null || need > 1 ? null : Math.max(0, need);
  const margin = Math.max(15, cost * 0.5);
  let verdict: GradingResult["verdict"], reason: string;
  if (profit >= margin) {
    verdict = "grade";
    reason = `Expected ${money(profit)} more than selling raw after ${money(cost)} in fees and shipping.`;
  } else if (profit > -margin / 2) {
    verdict = "borderline";
    reason = `Roughly break-even (${profit >= 0 ? "+" : ""}${money(profit)}). Grade it only if you want it slabbed for the binder.`;
  } else {
    verdict = "keep-raw";
    const g = i.centeringCap ? (i.gradeName ?? ((x: string) => x))(i.centeringCap) : "";
    reason = odds[0] === 0 && i.centeringCap
      ? `Centering caps it at ${i.company ?? "PSA"} ${g}, and a ${g} isn't worth ${money(cost)} in fees here.`
      : `Grading costs ${money(cost)} but only adds about ${money(Math.max(0, expected - i.raw))} on average.`;
  }
  return { odds, expected, cost, profit, breakEven10, verdict, reason };
}

// ---------- Grading companies and their service tiers ----------

export type TierStatus = "open" | "limited" | "paused" | "closed" | "unconfirmed";
export interface Tier {
  name: string;
  price?: number; // USD per card
  maxValue?: number; // USD declared value cap
  days?: string; // business days, company estimate
  status: TierStatus;
  since?: string; // ISO date the status took effect
  min?: number; // minimum cards per order
  note?: string;
}
export interface Company {
  id: string;
  name: string;
  url: string;
  grades: [string, string]; // top grade, next grade (e.g. PSA 10 / 9, Beckett 9.5 / 9)
  centering: [number, number]; // worst front centering share allowed for those grades
  checkedAt: string;
  source: string;
  tiers: Tier[];
}
export interface ServicesFile { currency: "USD"; checkedAt: string; note: string; companies: Company[] }

export const TIER_LABEL: Record<TierStatus, string> = { open: "Open", limited: "Limited", paused: "Paused", closed: "Closed", unconfirmed: "Check" };
export const isOpen = (t: Tier) => (t.status === "open" || t.status === "limited") && t.price != null;

/** Cheapest tier you can use right now for a card declared at `declared` USD. */
export function cheapestTier(c: Company, declared: number): Tier | undefined {
  return c.tiers.filter((t) => isOpen(t) && (t.maxValue == null || t.maxValue >= declared))
    .sort((a, b) => a.price! - b.price!)[0];
}

/** Best grade a company would allow for a measured worst-side centering share (e.g. 54 for 54/46). */
export function capFor(c: Company, worst: number | undefined): string | undefined {
  if (worst == null) return undefined;
  if (worst <= c.centering[0] + 1e-9) return "10";
  if (worst <= c.centering[1] + 1e-9) return "9";
  return "8";
}

/** Worst centering share from a saved string like "52/48 L/R, 51.7/48.3 T/B". */
export function worstFrom(centering?: string): number | undefined {
  if (!centering) return undefined;
  const nums = [...centering.matchAll(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g)].flatMap((m) => [Number(m[1]), Number(m[2])]);
  return nums.length ? Math.max(...nums) : undefined;
}

export interface CompanyResult {
  company: Company;
  tier?: Tier;
  feeCAD?: number;
  result?: GradingResult; // only when slab prices are known
}

/** Compare companies for one card. Slab values are CAD; fees are converted from USD. */
export function compareCompanies(
  companies: Company[],
  card: { raw: number; condition: Condition; worst?: number; values: Record<string, [number | undefined, number | undefined]> },
  usdToCad: number,
  shippingCAD: number,
): CompanyResult[] {
  return companies.map((company) => {
    const [top, next] = card.values[company.id] ?? [undefined, undefined];
    const cap = capFor(company, card.worst);
    // declare what the slab is likely worth (a top-grade guess if we know it, else 3× raw)
    const declaredCAD = top ?? card.raw * 3;
    const tier = cheapestTier(company, declaredCAD / usdToCad);
    if (!tier) return { company };
    const feeCAD = tier.price! * usdToCad;
    if (top == null || next == null) return { company, tier, feeCAD };
    const gradeName = (x: string) => (x === "10" ? company.grades[0] : x === "9" ? company.grades[1] : "8");
    const result = worthGrading({ raw: card.raw, psa10: top, psa9: next, condition: card.condition, centeringCap: cap, company: company.name, gradeName }, { fee: feeCAD, shipping: shippingCAD });
    return { company, tier, feeCAD, result };
  });
}

/** Tiers whose status changed to open/limited since the collector last looked. */
export function reopenedSince(companies: Company[], seen: Record<string, TierStatus>): { company: Company; tier: Tier }[] {
  const out: { company: Company; tier: Tier }[] = [];
  for (const c of companies) for (const t of c.tiers) {
    const was = seen[`${c.id}:${t.name}`];
    if (was && !(was === "open" || was === "limited") && isOpen(t)) out.push({ company: c, tier: t });
  }
  return out;
}
