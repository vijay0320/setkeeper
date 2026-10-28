import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analysePacks, observedRates, DEFAULT_MODEL } from "../src/lib/packs.ts";
import type { CardSet } from "../src/lib/types.ts";

const set = JSON.parse(readFileSync(new URL("../data/sets/30th-celebration.json", import.meta.url), "utf8")) as CardSet;
const price: Record<string, number> = { Regular: 0.5, "Pikachu Rare": 4, "Double Rare (ex)": 3, "Special Art Rare": 15, "Special Art ex": 60, "Futuristic Rare": 200, "RGB Mew": 100, Classic: 15, Energy: 0.25 };
const value = (id: string) => price[set.cards.find((c) => c.id === id)!.rarity];

test("fresh collector: ripping some packs beats singles only", () => {
  const a = analysePacks({ cards: set.cards, owned: new Set(), value, model: DEFAULT_MODEL, packPrice: 6.5, maxPacks: 40, resaleShare: 0.5, runs: 400 });
  assert.equal(a.points[0].total, a.singlesOnly);
  assert.ok(a.best.packs > 0, "packs help when you own nothing");
  assert.ok(a.best.total < a.singlesOnly);
  assert.ok(a.perPackNewValue > 6.5);
});

test("nearly complete collector: buy singles", () => {
  const owned = new Set(set.cards.filter((c) => c.rarity !== "Special Art ex").map((c) => c.id));
  const a = analysePacks({ cards: set.cards, owned, value, model: DEFAULT_MODEL, packPrice: 6.5, maxPacks: 40, resaleShare: 0, runs: 400 });
  assert.equal(a.best.packs, 0);
  assert.ok(a.perPackNewValue < 6.5);
});

test("results are reproducible and costs fall with each pack", () => {
  const args = { cards: set.cards, owned: new Set<string>(), value, model: DEFAULT_MODEL, packPrice: 6.5, maxPacks: 10, resaleShare: 0, runs: 200, seed: 9 };
  const a = analysePacks(args), b = analysePacks(args);
  assert.deepEqual(a.points, b.points);
  for (let k = 1; k <= 10; k++) assert.ok(a.points[k].singlesCost <= a.points[k - 1].singlesCost + 1e-9);
  assert.ok(a.points[10].newCards > 30 && a.points[10].newCards < 70);
});

test("observed pull rates from the pack log", () => {
  const rarity = (id: string) => set.cards.find((c) => c.id === id)?.rarity;
  const r = observedRates([{ id: "1", date: "2026-10-01", packs: 10, pricePerPack: 6, hits: ["092", "149"] }, { id: "2", date: "2026-10-02", packs: 10, pricePerPack: 6, hits: ["064"] }], rarity);
  assert.equal(r.packs, 20);
  assert.equal(r.counts["Double Rare (ex)"], 2);
  assert.equal(r.rates["Special Art ex"], 0.05);
});
