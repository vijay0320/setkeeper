import { test } from "node:test";
import assert from "node:assert/strict";
import { textOf, readTier, applyPage } from "../scripts/grading-scout.ts";

const html = `<div class="tier"><h3>Value</h3><p>$29.95 per card</p><span>Limited capacity</span></div>
<div class="tier"><h3>Base</h3><p>$39.95</p><p>Max value $500</p></div>
<div class="tier"><h3>Standard</h3><p>Temporarily paused</p></div>
<script>var x = "Value $1";</script>`;

test("reads tiers from a pricing page", () => {
  const t = textOf(html);
  assert.ok(!t.includes("var x"));
  const names = ["Value", "Base", "Standard"];
  assert.deepEqual(readTier(t, "Value", names), { price: 29.95, status: "limited" });
  assert.deepEqual(readTier(t, "Base", names), { price: 39.95, status: "open" });
  assert.equal(readTier(t, "Standard", names)?.status, "paused");
  assert.equal(readTier(t, "Premier"), undefined);
});

test("records reopenings and price changes", () => {
  const tiers = [
    { name: "Value", price: 20, status: "paused" as const },
    { name: "Base", price: 39.95, status: "open" as const },
    { name: "Standard", price: 59.95, status: "open" as const },
  ];
  const changes = applyPage(tiers, textOf(html), "2026-10-28");
  assert.deepEqual(changes, ["Value: paused → limited", "Value: $20 → $29.95", "Standard: open → paused"]);
  assert.equal(tiers[0].status, "limited");
  assert.equal((tiers[0] as { since?: string }).since, "2026-10-28");
});
