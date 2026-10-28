import { test } from "node:test";
import assert from "node:assert/strict";
import { worthGrading, applyCentering } from "../src/lib/grading.ts";

const costs = { fee: 30, shipping: 8 };

test("centering caps move probability down a grade", () => {
  assert.deepEqual(applyCentering([0.5, 0.4, 0.1], "10"), [0.5, 0.4, 0.1]);
  const nine = applyCentering([0.5, 0.4, 0.1], "9");
  assert.equal(nine[0], 0);
  assert.ok(Math.abs(nine[1] - 0.9) < 1e-9);
  assert.deepEqual(applyCentering([0.5, 0.4, 0.1], "7"), [0, 0, 1]);
});

test("a clean chase card is worth grading", () => {
  const r = worthGrading({ raw: 200, psa10: 600, psa9: 260, condition: "pristine", centeringCap: "10" }, costs);
  assert.equal(r.verdict, "grade");
  assert.ok(r.profit > 100);
  assert.ok(r.breakEven10! >= 0 && r.breakEven10! < 0.5);
});

test("a cheap card isn't worth the fees", () => {
  const r = worthGrading({ raw: 3, psa10: 25, psa9: 8, condition: "pristine", centeringCap: "10" }, costs);
  assert.equal(r.verdict, "keep-raw");
});

test("off-centre card loses its PSA 10 chance", () => {
  const centred = worthGrading({ raw: 80, psa10: 300, psa9: 110, condition: "pristine", centeringCap: "10" }, costs);
  const off = worthGrading({ raw: 80, psa10: 300, psa9: 110, condition: "pristine", centeringCap: "9" }, costs);
  assert.equal(off.odds[0], 0);
  assert.ok(off.profit < centred.profit);
  assert.equal(off.verdict, "keep-raw");
  assert.match(off.reason, /caps it at PSA 9/);
});

import services from "../data/grading/services.json" with { type: "json" };
import { cheapestTier, capFor, worstFrom, compareCompanies, reopenedSince, type ServicesFile } from "../src/lib/grading.ts";
const S = services as unknown as ServicesFile;
const co = (id: string) => S.companies.find((c) => c.id === id)!;

test("service data covers PSA, Beckett, CGC and TAG", () => {
  assert.deepEqual(S.companies.map((c) => c.id), ["psa", "bgs", "cgc", "tag"]);
  for (const c of S.companies) for (const t of c.tiers) {
    assert.ok(["open", "limited", "paused", "closed", "unconfirmed"].includes(t.status), `${c.id} ${t.name}`);
    if (t.status === "open") assert.ok(t.price! > 0, `${c.id} ${t.name} has a price`);
  }
});

test("picks the cheapest open tier that covers the declared value", () => {
  assert.equal(cheapestTier(co("psa"), 300)!.name, "Standard", "Value tiers are paused");
  assert.equal(cheapestTier(co("psa"), 1200)!.name, "Priority");
  assert.equal(cheapestTier(co("tag"), 200)!.name, "Value", "limited tiers still count");
  assert.equal(cheapestTier(co("tag"), 400)!.name, "Base");
  assert.equal(cheapestTier(co("cgc"), 600)!.name, "Economy");
  assert.equal(cheapestTier(co("bgs"), 100)!.name, "Express", "Base and Standard paused; Priority unconfirmed");
  assert.equal(cheapestTier(co("psa"), 50000), undefined);
});

test("centering caps and parsing", () => {
  assert.equal(worstFrom("52/48 L/R, 51.7/48.3 T/B"), 52);
  assert.equal(capFor(co("psa"), 54), "10");
  assert.equal(capFor(co("psa"), 58), "9");
  assert.equal(capFor(co("psa"), 70), "8");
});

test("compares companies for one card", () => {
  const r = compareCompanies(S.companies, { raw: 100, condition: "pristine", values: { psa: [400, 160], tag: [300, 140] } }, 1.38, 8);
  const psa = r.find((x) => x.company.id === "psa")!, tag = r.find((x) => x.company.id === "tag")!, cgc = r.find((x) => x.company.id === "cgc")!;
  assert.ok(psa.result && tag.result);
  assert.equal(cgc.result, undefined, "no slab prices entered for CGC");
  assert.ok(cgc.tier && cgc.feeCAD! > 0);
  assert.ok(Math.abs(psa.feeCAD! - 59.99 * 1.38) < 0.01);
});

test("spots tiers that reopened", () => {
  const seen = { "tag:Value": "paused", "psa:Value": "paused", "cgc:Bulk": "open" } as const;
  const r = reopenedSince(S.companies, seen);
  assert.deepEqual(r.map((x) => `${x.company.id}:${x.tier.name}`), ["tag:Value"]);
});
