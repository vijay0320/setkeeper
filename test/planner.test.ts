import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, progress, insights } from "../src/lib/planner.ts";
import { DEFAULT_SETTINGS as S, type Card, type Entry } from "../src/lib/types.ts";

const card = (id: string, rarity = "Regular", section = "Main Set"): Card => ({ id, section, number: id, name: "Card " + id, rarity });
const cards = [card("a"), card("b"), card("c", "Futuristic Rare", "Secret Rare"), card("d", "Pikachu Rare"), card("e", "Pikachu Rare")];

test("stays within budget and skips overpriced asks", () => {
  const entries: Record<string, Entry> = {
    a: { priceSeen: 5, market: 5 }, b: { priceSeen: 40, market: 10 }, c: { market: 60 }, d: { status: "have" }, e: { priceSeen: 3, market: 4 },
  };
  const p = plan(cards, entries, S, { budget: 20 });
  assert.ok(p.total <= 20);
  assert.deepEqual(p.picks.map((x) => x.card.id).sort(), ["a", "e"]);
  assert.equal(p.skipped[0].card.id, "b");
  assert.ok(p.completes.includes("Pikachu Rare"), "buying e completes Pikachu Rare");
});

test("chase cards win when the budget allows", () => {
  const entries: Record<string, Entry> = { a: { market: 5 }, b: { market: 5 }, c: { market: 30 }, d: { market: 5 }, e: { market: 5 } };
  const p = plan(cards, entries, S, { budget: 30 });
  assert.equal(p.picks[0].card.id, "c");
});

test("unpriced cards are reported, not planned", () => {
  const p = plan(cards, {}, S, { budget: 100 });
  assert.equal(p.picks.length, 0);
  assert.equal(p.needPrice.length, 5);
});

test("progress and insights", () => {
  const entries: Record<string, Entry> = { d: { status: "have" }, a: { status: "in-store", priceSeen: 1, market: 2 } };
  const g = progress(cards, entries, "rarity").find((x) => x.label === "Pikachu Rare")!;
  assert.equal(g.owned, 1);
  assert.equal(g.missing.length, 1);
  const tips = insights(cards, entries, S);
  assert.match(tips[0], /1 of 5/);
  assert.ok(tips.some((t) => /in stock/.test(t)));
});
