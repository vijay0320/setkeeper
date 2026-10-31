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
  assert.equal(urls[1], "https://shop.example/cart.js"); // currency check
  assert.equal(urls[2], "https://shop.example/collections/thirty/products.json?limit=250&page=1&currency=CAD");
  assert.equal(urls.length, 3); // a short page is the last one
});

test("asks for the shop's own currency and refuses prices in another", async () => {
  const seen: Record<string, string>[] = [];
  const usd = (async (url: string, init?: RequestInit) => {
    seen.push((init?.headers ?? {}) as Record<string, string>);
    if (url.endsWith("robots.txt")) return new Response("");
    if (url.endsWith("cart.js")) return new Response(JSON.stringify({ currency: "USD" }));
    return new Response(JSON.stringify({ products }));
  }) as unknown as typeof fetch;
  await assert.rejects(fetchShopify({ ...store, collection: "thirty" }, resolve30, usd), /came back in USD/);
  assert.match(seen[1].Cookie, /localization=CA; cart_currency=CAD/);
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

test("keeps what it read when Shopify stops paging, and retries a busy shop", async () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ title: `Thing ${i}`, handle: `t${i}`, variants: [] }));
  let calls = 0;
  const fake = (async (url: string) => {
    if (url.endsWith("robots.txt")) return new Response("");
    calls++;
    if (calls === 1) return new Response("busy", { status: 503, headers: { "retry-after": "0.001" } });
    if (url.includes("page=1")) return new Response(JSON.stringify({ products: [...many.slice(0, 249), products[0]] }));
    return new Response("too deep", { status: 400 });
  }) as unknown as typeof fetch;
  const stats = newStats();
  const { listings: ls } = await fetchShopify({ ...store, collection: "big" }, resolve30, fake, 200, stats);
  assert.ok(ls.some((l) => l.cardId === "092"));
  assert.match(stats.notes[0], /stopped at page 2/);
});

test("places one-letter and gendered names", () => {
  const i2 = buildIndex([
    { id: "xy10-105", localId: "105", name: "N", setId: "xy10" },
    { id: "base1-55", localId: "55", name: "Nidoran♂", setId: "base1" },
  ], [{ id: "xy10", name: "Fates Collide", official: 124, total: 125 }, { id: "base1", name: "Base Set", official: 102, total: 102 }]);
  assert.equal(matchCard("N (105/124) [XY: Fates Collide]", i2).card?.id, "xy10-105");
  assert.equal(matchCard("Nidoran (55/102) (Male) [Base Set Unlimited]", i2).card?.id, "base1-55");
});

test("tells ex cards from older cards with the same number", () => {
  const i3 = buildIndex([
    { id: "sv03.5-006", localId: "006", name: "Charizard ex", setId: "sv03.5" },
    { id: "ecard1-6", localId: "6", name: "Charizard", setId: "ecard1" },
  ], [{ id: "sv03.5", name: "151", official: 165, total: 207 }, { id: "ecard1", name: "Expedition Base Set", official: 165, total: 165 }]);
  assert.equal(matchCard("Charizard ex - 006/165 - Double Rare", i3).card?.id, "sv03.5-006");
  assert.equal(matchCard("Charizard - 6/165 - Holo", i3).card?.id, "ecard1-6");
  assert.equal(matchCard("Nidoran♀ - 029/165 - Common", buildIndex([{ id: "sv03.5-029", localId: "029", name: "Nidoran♀", setId: "sv03.5" }], [{ id: "sv03.5", name: "151", official: 165, total: 207 }])).card?.id, "sv03.5-029");
});

test("reads an in-stock collection first", () => {
  assert.deepEqual(singlesCollections([
    { handle: "pokemon-singles-all", title: "Pokemon Singles All", products_count: 90000 },
    { handle: "pokemon-singles-instock", title: "Pokemon Singles In Stock", products_count: 5000 },
    { handle: "pokemon-sv-singles", title: "Pokemon Scarlet & Violet Singles", products_count: 12000 },
  ]), ["pokemon-singles-instock", "pokemon-singles-all", "pokemon-sv-singles"]);
});

// shapes from the shops' real titles (Oct 30 run)
const ix = buildIndex([
  { id: "pop5-17", localId: "17", name: "Umbreon ★", setId: "pop5" },
  { id: "ex8-107", localId: "107", name: "Rayquaza ★", setId: "ex8" },
  { id: "sv03.5-006", localId: "006", name: "Charizard ex", setId: "sv03.5" },
  { id: "base1-19", localId: "19", name: "Dugtrio", setId: "base1" },
  { id: "swsh12tg-TG05", localId: "TG05", name: "Gardevoir", setId: "swsh12tg" },
  { id: "swsh10tg-TG05", localId: "TG05", name: "Gardevoir", setId: "swsh10tg" },
  { id: "swsh12tg-TG30", localId: "TG30", name: "Lugia VSTAR", setId: "swsh12tg" },
  { id: "swsh10tg-TG30", localId: "TG30", name: "Origin Forme Palkia VSTAR", setId: "swsh10tg" },
  { id: "swsh12pt5gg-GG27", localId: "GG27", name: "Swablu", setId: "swsh12pt5gg" },
  { id: "swsh12pt5gg-GG70", localId: "GG70", name: "Mewtwo VSTAR", setId: "swsh12pt5gg" },
  { id: "swshp-SWSH291", localId: "SWSH291", name: "Lucario VSTAR", setId: "swshp" },
  { id: "svp-053", localId: "053", name: "Mew ex", setId: "svp" },
  { id: "svp-051", localId: "051", name: "Snorlax", setId: "svp" },
  { id: "sv01-051", localId: "051", name: "Snorlax", setId: "sv01" },
  { id: "xyp-XY60", localId: "XY60", name: "Gyarados", setId: "xyp" },
  { id: "sv06-168", localId: "168", name: "Bloodmoon Ursaluna ex", setId: "sv06" },
  { id: "sv01-257", localId: "257", name: "Basic Lightning Energy", setId: "sv01" },
], [
  { id: "pop5", name: "POP Series 5", official: 17, total: 17 },
  { id: "ex8", name: "Deoxys", official: 107, total: 111 },
  { id: "sv03.5", name: "151", official: 165, total: 207 },
  { id: "base1", name: "Base Set", official: 102, total: 102 },
  { id: "swsh12tg", name: "Silver Tempest Trainer Gallery", official: 0, total: 30 },
  { id: "swsh10tg", name: "Astral Radiance Trainer Gallery", official: 0, total: 30 },
  { id: "swsh12pt5gg", name: "Crown Zenith Galarian Gallery", official: 0, total: 70 },
  { id: "swshp", name: "SWSH Black Star Promos", official: 307, total: 307 },
  { id: "svp", name: "SVP Black Star Promos", official: 200, total: 200 },
  { id: "sv01", name: "Scarlet & Violet", official: 198, total: 258 },
  { id: "xyp", name: "XY Black Star Promos", official: 211, total: 211 },
  { id: "sv06", name: "Twilight Masquerade", official: 167, total: 226 },
]);

test("places set codes, promo codes, subsets and lone numbers", () => {
  assert.equal(matchCard("Umbreon ★ [POP5-17]", ix).card?.id, "pop5-17");
  assert.equal(matchCard("Rayquaza ★ [EX8-107]", ix).card?.id, "ex8-107");
  assert.equal(matchCard("Charizard ex - Double Rare [sv035-006] [Ultra]", ix).card?.id, "sv03.5-006");
  assert.equal(matchCard("Dugtrio - Rare - Unlimited [base1U-19] [Non-Holo]", ix).card?.id, "base1-19");
  assert.equal(matchCard("Gardevoir (TG05/TG30) [Sword & Shield: Silver Tempest]", ix).card?.id, "swsh12tg-TG05");
  assert.equal(matchCard("Gardevoir (TG05/TG30) [Sword & Shield: Astral Radiance]", ix).card?.id, "swsh10tg-TG05");
  assert.equal(matchCard("Swablu GG27/70 - SWSH Crown Zenith Galarian Gallery Holofoil", ix).card?.id, "swsh12pt5gg-GG27");
  assert.equal(matchCard("Lucario VSTAR (SWSH291) [Sword & Shield: Black Star Promos]", ix).card?.id, "swshp-SWSH291");
  assert.equal(matchCard("Mew ex (SVP053) [Scarlet & Violet: Black Star Promos]", ix).card?.id, "svp-053");
  assert.equal(matchCard("Gyarados (XY60) (Prerelease Promo) [XY: Black Star Promos]", ix).card?.id, "xyp-XY60");
  assert.equal(matchCard("Snorlax (051) [Scarlet & Violet: Black Star Promos]", ix).card?.id, "svp-051");
  assert.equal(matchCard("Snorlax (051)", ix).reason, "ambiguous"); // promo or base set: can't tell
  assert.equal(matchCard("Bloodmoon Ursaluna ex (168) - Holofoil - Special Illustration Rare", ix).card?.id, "sv06-168");
  assert.equal(matchCard("Lightning Energy (257/198) [Scarlet & Violet: Base Set]", ix).card?.id, "sv01-257");
  assert.equal(matchCard("Pikachu (Holofoil) [Non-Holo]", ix).reason, "no number");
});

test("the daily archive packs small and gives back exactly what was collected", async () => {
  const { packArchive, unpackArchive } = await import("../scripts/scout/archive.ts");
  const sellers = [{ id: "s", name: "Shop", country: "CA", currency: "CAD" as const, kind: "store" as const, url: "https://shop.example" }];
  const ls = [
    { sellerId: "s", setId: "sv08.5", cardId: "sv08.5-161", price: 389.99, qty: 1, condition: "NM", printing: "holofoil", url: "https://shop.example/products/umbreon-ex-161-131", title: "Umbreon ex - 161/131" },
    { sellerId: "s", setId: "sv08.5", cardId: "sv08.5-161", price: 350, qty: 0, url: "https://shop.example/products/umbreon-ex-161-131-1", title: "Umbreon ex - 161/131" },
    { sellerId: "s", cardId: "092", price: 6.49, qty: 3, condition: "LP", url: "https://elsewhere.example/x", title: "Odd" },
    { sellerId: "s", cardId: "093", price: 1.1, qty: 1, shipping: 2 },
  ];
  const back = unpackArchive(packArchive("2026-10-30T10:00:00Z", sellers, [], ls));
  const key = (x: object) => JSON.stringify(x, Object.keys(x).sort());
  assert.deepEqual(back.listings.map(key).sort(), ls.map(key).sort());
  assert.equal(back.fetchedAt, "2026-10-30T10:00:00Z");
});

test("skips graded slabs and reads more title shapes", () => {
  const iy = buildIndex([
    { id: "base1-4", localId: "4", name: "Charizard", setId: "base1" },
    { id: "bw11-RC22", localId: "RC22", name: "Reshiram", setId: "bw11" },
    { id: "bw11-RC32", localId: "RC32", name: "Gardevoir", setId: "bw11" },
    { id: "sv08-036", localId: "036", name: "Ceruledge ex", setId: "sv08" },
    { id: "sv08.5-141", localId: "141", name: "Ortega", setId: "sv08.5" },
  ], [
    { id: "base1", name: "Base Set", official: 102, total: 102 },
    { id: "bw11", name: "Legendary Treasures", official: 113, total: 140 },
    { id: "sv08", name: "Surging Sparks", official: 191, total: 252 },
    { id: "sv08.5", name: "Prismatic Evolutions", official: 131, total: 180 },
  ]);
  assert.equal(matchCard("CHARIZARD (4) - POKEMON GAME - 1ST EDITION - HOLO - EX 5", iy).reason, "excluded");
  assert.equal(matchCard("Charizard - 4/102 - Holo - NM-MT 8", iy).reason, "excluded");
  assert.equal(matchCard("Charizard - 4/102 - Holo Rare", iy).card?.id, "base1-4");
  assert.equal(matchCard("Reshiram (Full Art) (RC22/113) - Holofoil - Ultra Rare", iy).card?.id, "bw11-RC22");
  assert.equal(matchCard("Ceruledge ex 36 - SV08 Surging Sparks Holofoil", iy).card?.id, "sv08-036");
  assert.equal(matchCard("Ortega 141 - SV Prismatic Evolutions Holofoil", iy).card?.id, "sv08.5-141");
});

test("a subset card reached two ways is still one card", () => {
  const iz = buildIndex([
    { id: "swsh9tg-TG04", localId: "TG04", name: "Jolteon", setId: "swsh9tg" },
    { id: "swsh9tg-TG30", localId: "TG30", name: "Charizard", setId: "swsh9tg" },
  ], [{ id: "swsh9tg", name: "Brilliant Stars Trainer Gallery", official: 30, total: 30 }]);
  assert.equal(matchCard("Jolteon - TG04/TG30 - Rare Ultra", iz).card?.id, "swsh9tg-TG04");
});

test("switches a shop to Canada through its country picker when cookies aren't enough", async () => {
  let picked = false;
  const fake = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("robots.txt")) return new Response("");
    if (url.endsWith("/localization")) { picked = true; return new Response("", { status: 302, headers: { "set-cookie": "localization=CA; path=/" } }); }
    if (url.endsWith("cart.js")) return new Response(JSON.stringify({ currency: picked && String((init?.headers as Record<string, string>)?.Cookie).includes("localization=CA") ? "CAD" : "USD" }));
    return new Response(JSON.stringify({ products }));
  }) as unknown as typeof fetch;
  const { listings } = await fetchShopify({ ...store, collection: "thirty" }, resolve30, fake);
  assert.ok(picked);
  assert.equal(listings.length, 3);
});

test("reads a shop's Canadian address when it prices by country", async () => {
  const urls: string[] = [];
  const fake = (async (url: string) => {
    urls.push(url);
    if (url.endsWith("robots.txt")) return new Response("");
    if (url.endsWith("/localization")) return new Response("", { status: 302 });
    if (url.endsWith("cart.js")) return new Response(JSON.stringify({ currency: url.includes("/en-ca/") ? "CAD" : "USD" }));
    return new Response(JSON.stringify({ products }));
  }) as unknown as typeof fetch;
  const stats = newStats();
  const { listings } = await fetchShopify({ ...store, collection: "thirty" }, resolve30, fake, 360, stats);
  assert.equal(listings.length, 3);
  assert.ok(urls.some((u) => u === "https://shop.example/en-ca/collections/thirty/products.json?limit=250&page=1&currency=CAD"));
  assert.match(stats.notes[0], /read from shop\.example\/en-ca/);
});
