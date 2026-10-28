// Smart buy planner: chooses which missing cards to buy within a budget and explains why.
import type { Card, Entry, Priority, Settings } from "./types.ts";
import { missing, owned } from "./types.ts";
import { checkPrice, estimatedCost, priorityOf, formatCAD } from "./pricing.ts";

export const PRIORITY_WEIGHT: Record<Priority, number> = { chase: 8, high: 4, normal: 2, low: 1 };

export interface Pick {
  card: Card;
  cost: number;
  reasons: string[];
}

export interface Plan {
  picks: Pick[];
  total: number;
  budget: number;
  completes: string[]; // groups this plan finishes
  needPrice: Card[]; // missing cards with no price, so they can't be planned
  skipped: { card: Card; reason: string }[];
}

export interface PlanOptions {
  budget: number;
  allowOverpriced?: boolean; // default: skip overpriced and scalper asks
  inStoreOnly?: boolean;
}

type Group = { key: string; label: string; members: Card[] };

function groupsFor(cards: Card[]): Map<string, Group[]> {
  const bySection = new Map<string, Card[]>();
  const byRarity = new Map<string, Card[]>();
  for (const c of cards) {
    bySection.set(c.section, [...(bySection.get(c.section) ?? []), c]);
    byRarity.set(c.rarity, [...(byRarity.get(c.rarity) ?? []), c]);
  }
  const groups: Group[] = [
    ...[...bySection].map(([k, m]) => ({ key: "s:" + k, label: k, members: m })),
    ...[...byRarity].map(([k, m]) => ({ key: "r:" + k, label: k, members: m })),
  ];
  const out = new Map<string, Group[]>();
  for (const g of groups) for (const c of g.members) out.set(c.id, [...(out.get(c.id) ?? []), g]);
  return out;
}

export function plan(cards: Card[], entries: Record<string, Entry>, s: Settings, o: PlanOptions): Plan {
  const groups = groupsFor(cards);
  const stillMissing = new Set(cards.filter((c) => missing(entries[c.id]?.status)).map((c) => c.id));
  const needPrice: Card[] = [];
  const skipped: { card: Card; reason: string }[] = [];
  const candidates: { card: Card; cost: number; base: number; reasons: string[] }[] = [];

  for (const card of cards) {
    if (!stillMissing.has(card.id)) continue;
    const e = entries[card.id];
    const cost = estimatedCost(e);
    if (cost == null) { needPrice.push(card); continue; }
    const inStore = e?.status === "in-store";
    if (o.inStoreOnly && !inStore) continue;
    const pc = checkPrice(e?.priceSeen, e?.market, s);
    if (!o.allowOverpriced && (pc.verdict === "over" || pc.verdict === "scalper")) {
      skipped.push({ card, reason: pc.note });
      continue;
    }
    const prio = priorityOf(card, e);
    const reasons: string[] = [];
    let base = PRIORITY_WEIGHT[prio];
    if (prio === "chase" || prio === "high") reasons.push(`${prio === "chase" ? "Chase" : "High-priority"} card`);
    if (pc.verdict === "deal") { base *= 1.35; reasons.push(`Deal: ${pc.note}`); }
    if (inStore) { base *= 1.2; reasons.push(`In stock at ${e?.store || "a store"}`); }
    if (e?.priceSeen == null) reasons.push(`Priced at market (${formatCAD(cost)})`);
    candidates.push({ card, cost, base, reasons });
  }

  const picks: Pick[] = [];
  const chosen = new Set<string>();
  let total = 0;
  const remaining = () => candidates.filter((c) => !chosen.has(c.card.id) && total + c.cost <= o.budget + 1e-9);

  // Greedy on value per dollar, re-scored each round so finishing a set/rarity group earns a bonus.
  for (;;) {
    const pool = remaining();
    if (!pool.length) break;
    let best: (typeof pool)[number] | undefined, bestRatio = -1, bestBonus: string[] = [];
    for (const c of pool) {
      let value = c.base;
      const finishes: string[] = [];
      for (const g of groups.get(c.card.id) ?? []) {
        const left = g.members.filter((m) => stillMissing.has(m.id) && !chosen.has(m.id) && m.id !== c.card.id);
        if (left.length === 0) { value += 2 + g.members.length * 0.05; finishes.push(g.label); }
      }
      const ratio = value / Math.max(c.cost, 0.25);
      if (ratio > bestRatio) { best = c; bestRatio = ratio; bestBonus = finishes; }
    }
    if (!best) break;
    chosen.add(best.card.id);
    total += best.cost;
    picks.push({ card: best.card, cost: best.cost, reasons: [...best.reasons, ...bestBonus.map((g) => `Completes ${g}`)] });
  }

  const completes = [...new Set(picks.flatMap((p) => p.reasons.filter((r) => r.startsWith("Completes ")).map((r) => r.slice(10))))];
  return { picks, total: Math.round(total * 100) / 100, budget: o.budget, completes, needPrice, skipped };
}

export interface GroupProgress {
  label: string;
  kind: "section" | "rarity";
  total: number;
  owned: number;
  missing: Card[];
  costToFinish?: number; // undefined if any missing card lacks a price
}

export function progress(cards: Card[], entries: Record<string, Entry>, kind: "section" | "rarity"): GroupProgress[] {
  const map = new Map<string, Card[]>();
  for (const c of cards) {
    const k = kind === "section" ? c.section : c.rarity;
    map.set(k, [...(map.get(k) ?? []), c]);
  }
  return [...map].map(([label, members]) => {
    const miss = members.filter((c) => !owned(entries[c.id]?.status));
    const costs = miss.map((c) => estimatedCost(entries[c.id]));
    return {
      label, kind, total: members.length, owned: members.length - miss.length, missing: miss,
      costToFinish: costs.every((x) => x != null) ? costs.reduce((a: number, b) => a + (b ?? 0), 0) : undefined,
    };
  });
}

/** Short, plain-language observations about the collection. */
export function insights(cards: Card[], entries: Record<string, Entry>, s: Settings): string[] {
  const out: string[] = [];
  const own = cards.filter((c) => owned(entries[c.id]?.status)).length;
  out.push(`${own} of ${cards.length} cards (${Math.round((100 * own) / cards.length)}%).`);
  const near = progress(cards, entries, "rarity")
    .filter((g) => g.owned > 0 && g.missing.length > 0 && g.missing.length <= 3)
    .sort((a, b) => a.missing.length - b.missing.length);
  for (const g of near.slice(0, 2))
    out.push(`${g.missing.length} away from every ${g.label}: ${g.missing.map((c) => `${c.name} ${c.number}`).join(", ")}.`);
  const inStore = cards.filter((c) => entries[c.id]?.status === "in-store");
  if (inStore.length) {
    const deals = inStore.filter((c) => checkPrice(entries[c.id]?.priceSeen, entries[c.id]?.market, s).verdict === "deal");
    out.push(`${inStore.length} missing cards are in stock somewhere${deals.length ? `, ${deals.length} at a deal` : ""}.`);
  }
  const bad = cards.filter((c) => ["over", "scalper"].includes(checkPrice(entries[c.id]?.priceSeen, entries[c.id]?.market, s).verdict) && missing(entries[c.id]?.status));
  if (bad.length) out.push(`Skip for now: ${bad.slice(0, 3).map((c) => c.name).join(", ")}${bad.length > 3 ? ` and ${bad.length - 3} more` : ""} ${bad.length === 1 ? "is" : "are"} priced well above market.`);
  const unpriced = cards.filter((c) => missing(entries[c.id]?.status) && estimatedCost(entries[c.id]) == null).length;
  if (unpriced) out.push(`${unpriced} missing cards have no price yet; add market values to plan purchases.`);
  return out;
}
