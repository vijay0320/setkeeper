import { test } from "node:test";
import assert from "node:assert/strict";
import { summariesFrom, setFrom, infoFrom, enrich, searchCards, rarityOrder, tcgdexIdFor30th } from "../src/lib/catalog.ts";
import { defaultShelf, addSetBinder, addPersonalBinder, addSlot, moveSlot, removeSlot, paginate, colorFor } from "../src/lib/binders.ts";

// Shapes recorded from the live TCGdex API (2026-10-27).
const rawSets = [
  { id: "base1", name: "Base Set", logo: "https://assets.tcgdex.net/en/base/base1/logo", cardCount: { total: 102, official: 102 } },
  { id: "A1", name: "Genetic Apex", logo: "https://assets.tcgdex.net/en/tcgp/A1/logo", cardCount: { total: 286, official: 226 } },
  { id: "sv03.5", name: "151", logo: "https://assets.tcgdex.net/en/sv/sv03.5/logo", symbol: "https://assets.tcgdex.net/univ/sv/sv03.5/symbol", cardCount: { total: 207, official: 165 } },
  { id: "30th-c", name: "30th Classic Collection", cardCount: { total: 30, official: 0 } },
  { id: "empty", name: "Empty", cardCount: { total: 0, official: 0 } },
];

test("set list keeps physical sets and finds their series", () => {
  const s = summariesFrom(rawSets);
  assert.deepEqual(s.map((x) => x.id), ["base1", "sv03.5", "30th-c"]);
  assert.equal(s[1].series, "sv");
  assert.equal(s[2].series, "other");
});

test("converts a TCGdex set", () => {
  const raw = { id: "sv03.5", name: "151", releaseDate: "2023-09-22", serie: { id: "sv", name: "Scarlet & Violet" }, logo: "https://assets.tcgdex.net/en/sv/sv03.5/logo",
    cardCount: { total: 207, official: 165 },
    cards: [{ id: "sv03.5-001", localId: "001", name: "Bulbasaur", image: "https://assets.tcgdex.net/en/sv/sv03.5/001" },
      { id: "sv03.5-199", localId: "199", name: "Charizard ex", image: "https://assets.tcgdex.net/en/sv/sv03.5/199" },
      { id: "sv03.5-TG01", localId: "TG01", name: "Odd one" }] };
  const set = setFrom(raw, { "sv03.5-199": { rarity: "Special illustration rare" } });
  assert.equal(set.cards[0].number, "001/165");
  assert.equal(set.cards[0].section, "Main Set");
  assert.equal(set.cards[1].section, "Secret Rare");
  assert.equal(set.cards[1].rarity, "Special illustration rare");
  assert.equal(set.cards[2].section, "Subset");
  assert.equal(set.cards[2].image, undefined);
  assert.equal(set.imageSuffix, "/low.webp");
  assert.deepEqual(set.sections, ["Main Set", "Secret Rare", "Subset"]);
  assert.equal(set.series, "Scarlet & Violet");
});

test("reads rarity and prices", () => {
  const c = { id: "sv03.5-025", rarity: "Common", pricing: { cardmarket: { trend: 0.15, avg: 0.16 },
    tcgplayer: { unit: "USD", "reverse-holofoil": { marketPrice: 0.86 }, normal: { marketPrice: 0.25 } } } };
  assert.deepEqual(infoFrom(c), { rarity: "Common", usd: 0.25, eur: 0.16,
    prices: [{ printing: "normal", tcg: { market: 0.25 }, cm: { trend: 0.15, avg30: 0.16 } }, { printing: "reverse-holofoil", tcg: { market: 0.86 } }] });
  assert.deepEqual(infoFrom({ id: "x", rarity: "None", pricing: { cardmarket: null, tcgplayer: null } }), {});
});

test("enriches with limited concurrency and survives failures", async () => {
  let inFlight = 0, peak = 0;
  const fake = (async (url: string) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (url.endsWith("bad")) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({ id: "x", rarity: "Rare" }));
  }) as unknown as typeof fetch;
  const ids = Array.from({ length: 20 }, (_, i) => `c${i}`).concat("bad");
  const seen: number[] = [];
  const out = await enrich(ids, (d) => seen.push(d), fake, 4);
  assert.equal(Object.keys(out).length, 21);
  assert.equal(out.c3.rarity, "Rare");
  assert.deepEqual(out.bad, {});
  assert.ok(peak <= 4);
  assert.equal(seen.at(-1), 21);
});

test("card search returns the set of each hit", async () => {
  const fake = (async () => new Response(JSON.stringify([{ id: "30th-c-001", localId: "001", name: "Charizard" }, { id: "sv03.5-006", localId: "006", name: "Charizard ex" }]))) as unknown as typeof fetch;
  const hits = await searchCards("charizard", fake);
  assert.deepEqual(hits.map((h) => h.setId), ["30th-c", "sv03.5"]);
});

test("rarity order and 30th id mapping", () => {
  assert.deepEqual(rarityOrder(["Special illustration rare", "Common", "Double rare", "Common"]), ["Common", "Double rare", "Special illustration rare"]);
  assert.equal(tcgdexIdFor30th("092"), "30th-092");
  assert.equal(tcgdexIdFor30th("cl-01"), "30th-c-001");
  assert.equal(tcgdexIdFor30th("mew-r"), undefined);
});

test("binder shelf", () => {
  const s = defaultShelf();
  const b1 = addSetBinder(s, "sv03.5", "151");
  assert.equal(addSetBinder(s, "sv03.5", "151"), b1, "one binder per set");
  assert.equal(b1.color, colorFor("sv03.5"));
  const p = addPersonalBinder(s, "  ", "#000", "carbon", 12);
  assert.equal(p.name, "My binder");
  for (const n of ["a", "b", "c"]) addSlot(p, { ref: n, setId: "x", name: n, number: "1" });
  addSlot(p, { ref: "z", setId: "x", name: "z", number: "1" }, 0);
  assert.deepEqual(p.slots!.map((x) => x.ref), ["z", "a", "b", "c"]);
  moveSlot(p, 0, 3);
  assert.deepEqual(p.slots!.map((x) => x.ref), ["a", "b", "c", "z"]);
  removeSlot(p, 1);
  assert.deepEqual(p.slots!.map((x) => x.ref), ["a", "c", "z"]);
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(paginate([], 9), [[]]);
});
