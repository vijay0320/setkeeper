import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { CardSet } from "../src/lib/types.ts";
import { matchTitle } from "../scripts/scout/match.ts";
import { listingsFromProducts, fetchShopify, type ShopifyStore } from "../scripts/scout/shopify.ts";
import { fromItems, query } from "../scripts/scout/ebay.ts";

const set = JSON.parse(readFileSync(new URL("../data/sets/30th-celebration.json", import.meta.url), "utf8")) as CardSet;
const card = (id: string) => set.cards.find((c) => c.id === id)!;

test("matches listing titles to cards", () => {
  assert.equal(matchTitle("Umbreon ex - 092/128 - Double Rare - 30th Celebration (EN)", set), "092");
  assert.equal(matchTitle("Pokemon 30th Celebration Pikachu ex 149/128 Special Art Rare NM", set), "149");
  assert.equal(matchTitle("Charizard 4/102 Classic Collection 30th Celebration", set), "cl-01");
  assert.equal(matchTitle("Darkrai & Cresselia LEGEND 99/102 30th Celebration Classic", set), "cl-19");
  assert.equal(matchTitle("Mew R/RGB 30th Celebration Secret Rare", set), "mew-r");
  assert.equal(matchTitle("Exeggcute 1/128 30th Celebration", set), "001");
});

test("rejects graded, sealed, other sets and mismatched names", () => {
  assert.equal(matchTitle("PSA 10 Umbreon ex 092/128 30th Celebration", set), undefined);
  assert.equal(matchTitle("Charizard 4/102 Base Set Holo", set), undefined);
  assert.equal(matchTitle("30th Celebration Booster Pack", set), undefined);
  assert.equal(matchTitle("Pikachu 092/128 30th Celebration", set), undefined, "number and name disagree");
  assert.equal(matchTitle("Umbreon ex 092/128 Japanese 30th Celebration", set), undefined);
});

const store: ShopifyStore = { id: "s", name: "Shop", domain: "shop.example", currency: "CAD", country: "CA", shipping: { base: 5, freeOver: 50 } };
const products = [
  { title: "Umbreon ex - 092/128 - 30th Celebration", handle: "umbreon-ex-092", variants: [
    { title: "Near Mint", price: "6.49", available: true, inventory_quantity: 3 },
    { title: "Lightly Played", price: "5.25", available: true, inventory_quantity: 0 },
    { title: "Moderately Played", price: "4.00", available: true } ] },
  { title: "Exeggcute - 001/128 - 30th Celebration", handle: "exeggcute", variants: [{ title: "Default Title", price: "0.35", available: true }] },
  { title: "30th Celebration Elite Trainer Box", handle: "etb", variants: [{ title: "Default Title", price: "79.99", available: true }] },
];

test("reads Shopify products.json", () => {
  const ls = listingsFromProducts(store, products, set);
  assert.equal(ls.length, 3);
  assert.deepEqual(ls[0], { sellerId: "s", cardId: "092", price: 6.49, qty: 3, condition: "NM", url: "https://shop.example/products/umbreon-ex-092", title: products[0].title });
  assert.equal(ls[1].condition, "MP");
  assert.equal(ls[2].cardId, "001");
});

test("pages through a Shopify collection until empty", async () => {
  const urls: string[] = [];
  const fake = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ products: url.includes("page=1") ? products : [] }));
  }) as unknown as typeof fetch;
  const ls = await fetchShopify({ ...store, collection: "thirty" }, set, fake);
  assert.equal(ls.length, 3);
  assert.equal(urls[0], "https://shop.example/collections/thirty/products.json?limit=250&page=1");
  assert.equal(urls.length, 2);
});

test("reads eBay Browse API results", () => {
  const items = [
    { title: "Umbreon ex 092/128 30th Celebration Pokemon NM", itemWebUrl: "https://www.ebay.ca/itm/1", condition: "Ungraded - Near Mint",
      price: { value: "5.50", currency: "CAD" }, shippingOptions: [{ shippingCost: { value: "2.00", currency: "CAD" } }],
      seller: { username: "maplecards", feedbackPercentage: "99.8" }, itemLocation: { country: "CA" } },
    { title: "PSA 10 Umbreon ex 092/128 30th Celebration", itemWebUrl: "x", price: { value: "90", currency: "USD" },
      seller: { username: "slabs", feedbackPercentage: "100" }, itemLocation: { country: "US" } },
    { title: "Umbreon ex 092/128 30th Celebration", itemWebUrl: "y", price: { value: "3", currency: "USD" },
      seller: { username: "lowfeedback", feedbackPercentage: "91.0" }, itemLocation: { country: "US" } },
  ];
  const r = fromItems(items, card("092"), set, { marketplace: "EBAY_CA", deliveryCountry: "CA", perCard: 30 });
  assert.equal(r.listings.length, 1);
  assert.deepEqual(r.listings[0], { sellerId: "ebay:maplecards", cardId: "092", price: 5.5, qty: 1, condition: "NM", shipping: 2, url: "https://www.ebay.ca/itm/1", title: items[0].title });
  assert.equal(r.sellers[0].kind, "marketplace");
  assert.equal(query(card("mew-g")), "Mew RGB 30th Celebration");
});
