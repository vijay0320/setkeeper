import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPrice, estimatedCost, defaultPriority } from "../src/lib/pricing.ts";
import { DEFAULT_SETTINGS as S } from "../src/lib/types.ts";

test("price verdicts follow the thresholds", () => {
  assert.equal(checkPrice(8, 10, S).verdict, "deal");
  assert.equal(checkPrice(9, 10, S).verdict, "deal");
  assert.equal(checkPrice(11, 10, S).verdict, "fair");
  assert.equal(checkPrice(12, 10, S).verdict, "over");
  assert.equal(checkPrice(16, 10, S).verdict, "scalper");
  assert.equal(checkPrice(10, undefined, S).verdict, "unknown");
  assert.equal(checkPrice(undefined, 10, S).verdict, "unknown");
});

test("estimated cost prefers the asking price", () => {
  assert.equal(estimatedCost({ priceSeen: 5, market: 7 }), 5);
  assert.equal(estimatedCost({ market: 7 }), 7);
  assert.equal(estimatedCost({}), undefined);
});

test("default priorities", () => {
  const c = (rarity: string, name = "X") => ({ id: "x", section: "s", number: "1", name, rarity });
  assert.equal(defaultPriority(c("Futuristic Rare")), "chase");
  assert.equal(defaultPriority(c("Classic", "Charizard")), "chase");
  assert.equal(defaultPriority(c("Special Art ex")), "high");
  assert.equal(defaultPriority(c("Energy")), "low");
  assert.equal(defaultPriority(c("Regular")), "normal");
});
