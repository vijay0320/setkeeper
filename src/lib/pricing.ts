import type { Card, Entry, Priority, Settings } from "./types.ts";

export type Verdict = "deal" | "fair" | "over" | "scalper" | "unknown";

export const VERDICT_LABEL: Record<Verdict, string> = {
  deal: "Deal",
  fair: "Fair",
  over: "Overpriced",
  scalper: "Scalper price",
  unknown: "No market price",
};

export interface PriceCheck {
  verdict: Verdict;
  ratio?: number; // priceSeen / market
  note: string;
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** Compare an asking price with fair market value using the collector's thresholds. */
export function checkPrice(priceSeen: number | undefined, market: number | undefined, s: Settings): PriceCheck {
  if (priceSeen == null || !(priceSeen >= 0)) return { verdict: "unknown", note: "No asking price recorded" };
  if (market == null || !(market > 0)) return { verdict: "unknown", note: `Asking ${money(priceSeen)}; add a market value to judge it` };
  const ratio = priceSeen / market;
  const pct = Math.round(Math.abs(ratio - 1) * 100);
  if (ratio <= s.dealBelow) return { verdict: "deal", ratio, note: `${pct}% under market (${money(market)})` };
  if (ratio > s.scalperAbove) return { verdict: "scalper", ratio, note: `${pct}% over market (${money(market)}) — walk away` };
  if (ratio > s.overAbove) return { verdict: "over", ratio, note: `${pct}% over market (${money(market)})` };
  return { verdict: "fair", ratio, note: ratio >= 1 ? `${pct}% over market` : `${pct}% under market` };
}

/** Best estimate of what the card will cost to buy: asking price if seen, else market value. */
export function estimatedCost(e: Entry | undefined): number | undefined {
  if (e?.priceSeen != null && e.priceSeen >= 0) return e.priceSeen;
  if (e?.market != null && e.market > 0) return e.market;
  return undefined;
}

const CHASE = /futuristic|rgb mew|special illustration|hyper rare|mega hyper|gold|rainbow|secret/i;
const HIGH = /special art ex|classic|illustration rare|ultra rare|shiny/i;
export function defaultPriority(card: Card): Priority {
  if (card.rarity === "Futuristic Rare" || card.rarity === "RGB Mew" || (card.rarity === "Classic" && card.name === "Charizard")) return "chase";
  if (card.rarity === "Special Art ex" || card.rarity === "Classic") return "high";
  if (card.rarity === "Energy") return "low";
  if (CHASE.test(card.rarity)) return "chase";
  if (HIGH.test(card.rarity)) return "high";
  return "normal";
}

export const priorityOf = (card: Card, e?: Entry): Priority => e?.priority ?? defaultPriority(card);

export const formatCAD = (n: number | undefined) =>
  n == null ? "—" : n.toLocaleString("en-CA", { style: "currency", currency: "CAD" });
