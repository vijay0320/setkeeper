// Packs vs singles: is it cheaper to rip packs, buy singles, or rip a few and then buy?
//
// A pack is modelled slot by slot (30th Celebration: one Pikachu card, foil cards, one
// foil energy). The odds of each hit rarity per pack are editable: the defaults are
// placeholders until the collector's own pack log or published pull rates replace them.
// A Monte Carlo run opens K packs for K = 0..max and prices the cards still missing as
// singles, giving the expected total cost of each strategy.
import type { Card } from "./types.ts";

export interface PackModel {
  pikachuSlot: boolean; // one Pikachu Rare in every pack
  energySlot: boolean; // one basic energy in every pack
  regularSlots: number; // regular foils besides the hit slot
  regular?: string[]; // rarities that fill regular slots (default ["Regular"])
  hitOdds: Record<string, number>; // chance per pack that the hit slot is this rarity (rest = a regular)
}

export const DEFAULT_MODEL: PackModel = {
  pikachuSlot: true,
  energySlot: true,
  regularSlots: 4,
  hitOdds: {
    "Double Rare (ex)": 0.2,
    "Classic": 0.1,
    "Special Art Rare": 0.06,
    "Special Art ex": 0.025,
    "Futuristic Rare": 0.004,
    "RGB Mew": 0.0015,
  },
};

export interface PackSession {
  id: string;
  date: string;
  packs: number;
  pricePerPack: number;
  store?: string;
  hits: string[]; // card ids pulled that are worth logging (anything above a regular)
}

export interface StrategyPoint {
  packs: number;
  packCost: number;
  singlesCost: number; // expected cost of buying what's still missing
  resale: number; // expected value recovered from duplicate hits (resale share × value)
  total: number; // packCost + singlesCost − resale
  newCards: number; // expected new cards pulled
}

export interface PackAnalysis {
  points: StrategyPoint[];
  best: StrategyPoint;
  singlesOnly: number;
  perPackNewValue: number; // expected value of cards you still need, per pack, at your current state
  priced: number; // missing cards that have a value
  unpriced: number;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function analysePacks(opts: {
  cards: Card[];
  owned: Set<string>;
  value: (id: string) => number | undefined; // CAD, undefined = no price
  model: PackModel;
  packPrice: number;
  maxPacks: number;
  resaleShare: number; // 0..1, share of a duplicate hit's value you'd get back
  runs?: number;
  seed?: number;
}): PackAnalysis {
  const { cards, owned, value, model, packPrice, maxPacks, resaleShare } = opts;
  const runs = opts.runs ?? 1500;
  const rand = rng(opts.seed ?? 30);
  const byRarity = new Map<string, Card[]>();
  for (const c of cards) byRarity.set(c.rarity, [...(byRarity.get(c.rarity) ?? []), c]);
  const regular = (model.regular ?? ["Regular"]).flatMap((r) => byRarity.get(r) ?? []);
  const pikachu = byRarity.get("Pikachu Rare") ?? [];
  const energy = byRarity.get("Energy") ?? [];
  const hitTable = Object.entries(model.hitOdds).filter(([r]) => byRarity.has(r));
  const pick = (list: Card[]) => list[Math.floor(rand() * list.length)];

  const missing = cards.filter((c) => !owned.has(c.id));
  const priced = missing.filter((c) => value(c.id) != null);
  const singlesOnly = priced.reduce((a, c) => a + value(c.id)!, 0);

  function openPack(out: Card[]) {
    if (model.pikachuSlot && pikachu.length) out.push(pick(pikachu));
    if (model.energySlot && energy.length) out.push(pick(energy));
    for (let i = 0; i < model.regularSlots; i++) if (regular.length) out.push(pick(regular));
    let r = rand(), hit: Card | undefined;
    for (const [rarity, p] of hitTable) {
      if (r < p) { hit = pick(byRarity.get(rarity)!); break; }
      r -= p;
    }
    out.push(hit ?? pick(regular));
  }

  const sumSingles = new Float64Array(maxPacks + 1);
  const sumResale = new Float64Array(maxPacks + 1);
  const sumNew = new Float64Array(maxPacks + 1);
  for (let run = 0; run < runs; run++) {
    const have = new Set(owned);
    let stillNeed = singlesOnly, resale = 0, fresh = 0;
    sumSingles[0] += stillNeed;
    for (let k = 1; k <= maxPacks; k++) {
      const pulled: Card[] = [];
      openPack(pulled);
      for (const c of pulled) {
        const v = value(c.id) ?? 0;
        if (!have.has(c.id)) { have.add(c.id); stillNeed -= v; fresh++; }
        else if (!(model.regular ?? ["Regular"]).includes(c.rarity) && c.rarity !== "Energy") resale += v * resaleShare;
      }
      sumSingles[k] += Math.max(0, stillNeed);
      sumResale[k] += resale;
      sumNew[k] += fresh;
    }
  }

  const points: StrategyPoint[] = [];
  for (let k = 0; k <= maxPacks; k++) {
    const singlesCost = sumSingles[k] / runs, resale = sumResale[k] / runs;
    points.push({ packs: k, packCost: k * packPrice, singlesCost, resale, total: k * packPrice + singlesCost - resale, newCards: sumNew[k] / runs });
  }
  const best = points.reduce((a, b) => (b.total < a.total - 0.01 ? b : a));
  const perPackNewValue = maxPacks >= 1 ? points[0].singlesCost - points[1].singlesCost : 0;
  return { points, best, singlesOnly, perPackNewValue, priced: priced.length, unpriced: missing.length - priced.length };
}

/** Pull rates seen in the collector's own pack log, per pack. */
export function observedRates(sessions: PackSession[], rarityOf: (id: string) => string | undefined) {
  const packs = sessions.reduce((a, s) => a + s.packs, 0);
  const counts: Record<string, number> = {};
  for (const s of sessions) for (const h of s.hits) { const r = rarityOf(h); if (r) counts[r] = (counts[r] ?? 0) + 1; }
  return { packs, rates: Object.fromEntries(Object.entries(counts).map(([r, n]) => [r, n / (packs || 1)])), counts };
}
