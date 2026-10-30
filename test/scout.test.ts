import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { CardSet } from "../src/lib/types.ts";
import { matchTitle } from "../scripts/scout/match.ts";
import { listingsFromProducts, fetchShopify, singlesCollections, newStats, type ShopifyStore, type Resolver } from "../scripts/scout/shopify.ts";
import { buildIndex, matchCard, appCard } from "../src/lib/cardmatch.ts";
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

const resolve30: Resolver = (title) => { const id = matchTitle(title, set); return id ? { setId: "30th-celebration", cardId: id } : { miss: "no card" }; };

test("reads Shopify products.json", () => {
  const stats = newStats();
  const ls = listingsFromProducts(store, products, resolve30, "", stats);
  assert.equal(ls.length, 3);
  assert.deepEqual(ls[0], { sellerId: "s", setId: "30th-celebration", cardId: "092", price: 6.49, qty: 3, condition: "NM", url: "https://shop.example/products/umbreon-ex-092", title: products[0].title });
  assert.equal(ls[1].condition, "MP");
  assert.equal(ls[2].cardId, "001");
  assert.deepEqual([stats.products, stats.matched, stats.soldOut], [3, 2, 0]);
});

test("keeps a sold-out marker so the app can say so", () => {
  const ls = listingsFromProducts(store, [{ title: "Umbreon ex - 092/128 - 30th Celebration", handle: "u", variants: [{ title: "Near Mint", price: "380", available: false }] }], resolve30);
  assert.deepEqual(ls.map((l) => [l.cardId, l.qty, l.price]), [["092", 0, 380]]);
});

test("finds a shop's Pokémon singles collection", () => {
  assert.deepEqual(singlesCollections([
    { handle: "magic-singles", title: "Magic Singles", products_count: 90000 },
    { handle: "pokemon-singles", title: "Pokémon Singles", products_count: 12000 },
    { handle: "pokemon-japanese-singles", title: "Pokemon Japanese Singles", products_count: 3000 },
    { handle: "pokemon-sealed", title: "Pokemon Sealed", products_count: 400 },
  ]), ["pokemon-singles"]);
});

// a slice of the TCGdex card list: same number in several sets, a subset, a secret rare
const idx = buildIndex([
  { id: "sv08.5-161", localId: "161", name: "Umbreon ex", setId: "sv08.5" },
  { id: "sv03.5-199", localId: "199", name: "Charizard ex", setId: "sv03.5" },
  { id: "sv03.5-025", localId: "025", name: "Pikachu", setId: "sv03.5" },
  { id: "base1-4", localId: "4", name: "Charizard", setId: "base1" },
  { id: "base2-4", localId: "4", name: "Charizard", setId: "base2" }, // pretend: same number, same size
  { id: "swsh11tg-TG05", localId: "TG05", name: "Pikachu", setId: "swsh11tg" },
  { id: "swsh11tg-TG30", localId: "TG30", name: "Mewtwo VSTAR", setId: "swsh11tg" },
  { id: "30th-092", localId: "092", name: "Umbreon ex", setId: "30th" },
], [
  { id: "sv08.5", name: "Prismatic Evolutions", official: 131, total: 180 },
  { id: "sv03.5", name: "151", official: 165, total: 207 },
  { id: "base1", name: "Base Set", official: 102, total: 102 },
  { id: "base2", name: "Base Set 2", official: 102, total: 130 },
  { id: "swsh11tg", name: "Lost Origin Trainer Gallery", official: 0, total: 30 },
  { id: "30th", name: "30th Celebration", official: 128, total: 199 },
]);

test("places listings from any set by number and name", () => {
  assert.equal(matchCard("Umbreon ex - 161/131 - Prismatic Evolutions", idx).card?.id, "sv08.5-161");
  assert.equal(matchCard("Charizard ex (199/165) [Scarlet & Violet: 151]", idx).card?.id, "sv03.5-199");
  assert.equal(matchCard("Pikachu TG05/TG30 Lost Origin", idx).card?.id, "swsh11tg-TG05");
  assert.equal(matchCard("Pikachu - 25/165", idx).card?.id, "sv03.5-025");
  assert.equal(matchCard("Charizard 4/102 Base Set 2", idx).card?.id, "base2-4");
  assert.equal(matchCard("Charizard 4/102 Holo", idx).reason, "ambiguous"); // two sets, nothing to tell them apart
  assert.equal(matchCard("Pikachu 161/131", idx).reason, "name differs");
  assert.equal(matchCard("Umbreon ex 161/131 Booster Box", idx).reason, "excluded");
  assert.equal(matchCard("Mystery card", idx).reason, "no number");
  assert.deepEqual(appCard(matchCard("Umbreon ex 092/128", idx).card!), { setId: "30th-celebration", cardId: "092" });
});

test("pages through a Shopify collection until empty", async () => {
  const urls: string[] = [];
  const fake = (async (url: string) => {
    urls.push(url);
    if (url.endsWith("robots.txt")) return new Response("User-agent: *\nDisallow: /cart\nDisallow: /policies/");
    return new Response(JSON.stringify({ products: url.includes("page=1") ? products : [] }));
  }) as unknown as typeof fetch;
  const { listings: ls } = await fetchShopify({ ...store, collection: "thirty" }, resolve30, fake);
  assert.equal(ls.length, 3);
  assert.equal(urls[0], "https://shop.example/robots.txt");
  assert.equal(urls[1], "https://shop.example/collections/thirty/products.json?limit=250&page=1");
  assert.equal(urls.length, 2); // a short page is the last one
});

test("leaves a shop alone when robots.txt says so, or when it has no singles collection", async () => {
  const shut = (async (url: string) => new Response(url.endsWith("robots.txt") ? "User-agent: *\nDisallow: /" : "{}")) as unknown as typeof fetch;
  await assert.rejects(fetchShopify({ ...store, collection: "thirty" }, resolve30, shut), /robots\.txt/);
  const none = (async (url: string) => new Response(url.endsWith("robots.txt") ? "" : JSON.stringify({ collections: [{ handle: "mtg", title: "Magic Singles" }] }))) as unknown as typeof fetch;
  await assert.rejects(fetchShopify({ ...store, pokemonSingles: true }, resolve30, none), /no Pokémon singles/);
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
  assert.match(r.listings[0].sellerId, /^ebay:[0-9a-f]{12}$/); // usernames are never stored
  assert.ok(!JSON.stringify(r).includes("maplecards"));
  assert.deepEqual(r.listings[0], { sellerId: r.listings[0].sellerId, cardId: "092", price: 5.5, qty: 1, condition: "NM", shipping: 2, url: "https://www.ebay.ca/itm/1", title: items[0].title });
  assert.equal(r.sellers[0].kind, "marketplace");
  assert.equal(r.sellers[0].name, "eBay seller, CA · 99.8% positive");
  assert.equal(query(card("mew-g")), "Mew RGB 30th Celebration");
});

test("titles in a shop's set collection needn't name the set", () => {
  assert.equal(matchTitle("Umbreon ex - 092/128 - Special Illustration Rare", set), undefined);
  assert.equal(matchTitle("Umbreon ex - 092/128 - Special Illustration Rare", set, true), "092");
  assert.equal(matchTitle("Umbreon ex 092/128 Booster Box", set, true), undefined);
});
