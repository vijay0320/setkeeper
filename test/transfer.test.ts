import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importRows, parseCSV, exportCSV, parseStatus } from "../src/lib/transfer.ts";
import { emptyCollection } from "../src/lib/store.ts";
import type { CardSet } from "../src/lib/types.ts";

const set = JSON.parse(readFileSync(new URL("../data/sets/30th-celebration.json", import.meta.url), "utf8")) as CardSet;

test("status words from spreadsheets", () => {
  assert.equal(parseStatus("Have"), "have");
  assert.equal(parseStatus("Stock in store"), "in-store");
  assert.equal(parseStatus("Want Upgrade"), "upgrade");
  assert.equal(parseStatus("Ordered"), "ordered");
  assert.equal(parseStatus("Need"), "need");
});

test("imports a Google Sheets CSV, splitting 'Store (date)'", () => {
  const csv = 'Section,Card #,Name,Status,Store name,Qty\nMain Set,020/128,Palkia,Stock in store,Hobbiesville(October 27),\n' +
    'Classic Collection,4/102,Charizard,Have,,2\nBasic Energy,—,Basic Grass Energy,Have,,\nBasic Energy,—,Basic Fire Energy,Need,,\n';
  const r = importRows(set, parseCSV(csv));
  assert.equal(r.matched, 4);
  assert.deepEqual(r.entries["020"], { status: "in-store", store: "Hobbiesville", seenOn: "2026-10-27" });
  assert.deepEqual(r.entries["cl-01"], { status: "have", qty: 2 });
  assert.equal(r.entries["en-grass"].status, "have");
  assert.equal(r.entries["en-fire"].status, "need");
});

test("CSV export round-trips through import", () => {
  const c = emptyCollection(set.id);
  c.entries["001"] = { status: "have", qty: 3 };
  c.entries["157"] = { status: "in-store", priceSeen: 120, market: 100, store: "Shop", printing: "reverse-holofoil", condition: "LP" };
  const r = importRows(set, parseCSV(exportCSV(set, c)));
  assert.equal(r.entries["157"].printing, "reverse-holofoil");
  assert.equal(r.entries["157"].condition, "LP");
  assert.equal(r.entries["001"].condition, undefined);
  assert.equal(r.matched, set.cards.length);
  assert.equal(r.entries["001"].qty, 3);
  assert.equal(r.entries["157"].priceSeen, 120);
  assert.equal(r.entries["157"].status, "in-store");
});

test("set data is complete", () => {
  assert.equal(set.cards.length, 199);
  assert.equal(new Set(set.cards.map((c) => c.id)).size, 199);
  assert.equal(set.cards.filter((c) => c.image).length, 188);
});
