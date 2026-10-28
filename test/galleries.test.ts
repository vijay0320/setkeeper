import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseRanges, toRanges, shortName, officialImage, gallerySet, parseIndexPage, parseGalleryPage, versionsFromScript, idFoldersFromScript,
  cardsJsonPath, partFrom, matchTcgdex, mergeIndex, findPart, type GalleryIndex,
} from "../src/lib/galleries.ts";

const idx = JSON.parse(readFileSync("data/galleries/index.json", "utf8")) as GalleryIndex;
const G = (slug: string) => idx.galleries.find((g) => g.slug === slug)!;

test("ranges round-trip", () => {
  assert.deepEqual(parseRanges("1-3,7,9-10"), [1, 2, 3, 7, 9, 10]);
  assert.equal(toRanges([10, 9, 7, 3, 2, 1, 2]), "1-3,7,9-10");
});

test("bundled index matches the official category counts", () => {
  // counts read from each gallery's cards.json on 2026-10-28
  const expect: Record<string, Record<string, number>> = {
    "ascended-heroes": { "mega-evolution-pokemon": 34, "trainers-pokemon": 34, ex: 70, "special-art": 78 },
    "destined-rivals": { "special-art": 62, ex: 43, "hyper-rare": 6, "trainers-pokemon": 128 },
    "paldea-evolved": { ex: 44, "alt-art": 77, paldea: 122, abil: 44 },
    "scarlet-violet": { ex: 30, tera: 4, "alt-art": 54, "gen-9": 99 },
    "temporal-forces": { "ace-spec": 7, "ancient-future": 42, "special-art": 32, ex: 39, "hyper-rare": 6 },
    "paradox-rift": { "ancient-future": 32, "special-art": 49, ex: 46, "tera-ex": 12 },
    "journey-together": { trainers: 45, "special-art": 31, ex: 32, "hyper-rare": 3 },
    "surging-sparks": { "ace-spec": 8, "special-art": 58, ex: 40, "hyper-rare": 6 },
    "twilight-masquerade": { "ace-spec": 6, paradox: 8, "special-art": 53, ex: 37, "hyper-rare": 6 },
    "prismatic-evolutions": { "ace-spec": 6, "special-art": 49, ex: 53, "hyper-rare": 5 },
    "151": { ex: 29, "alt-art": 23, first: 21 },
    "obsidian-flames": { ex: 33, "special-art": 18, tera: 12, "type-shifted": 10 },
  };
  for (const [slug, cats] of Object.entries(expect))
    for (const [k, n] of Object.entries(cats)) assert.equal(parseRanges(G(slug).parts[0].categories[k]).length, n, `${slug} ${k}`);
  const bw = G("black-white");
  assert.deepEqual(bw.parts.map((p) => [p.label, p.count, parseRanges(p.categories.ex).length, parseRanges(p.categories["special-art"]).length]), [["Black Bolt", 172, 19, 86], ["White Flare", 173, 19, 87]]);
  assert.equal(idx.galleries.length, 22);
});

test("names and image URLs follow the gallery's own pattern", () => {
  assert.equal(shortName("Pokémon TCG: Scarlet & Violet—Surging Sparks"), "Surging Sparks");
  assert.equal(shortName("Pokémon TCG: Mega Evolution"), "Mega Evolution");
  assert.equal(officialImage(idx.imageHost, G("30th-celebration"), G("30th-celebration").parts[0], 1), "https://dz3we2x72f7ol.cloudfront.net/expansions/30th-celebration/en-us/2M6P_EN_1.png");
  assert.equal(officialImage(idx.imageHost, G("30th-celebration"), G("30th-celebration").parts[0], 4, "classic-collection"), "https://dz3we2x72f7ol.cloudfront.net/expansions/30th-celebration/en-us/2M6P_Classic_EN_4.png");
  const bw = G("black-white");
  assert.equal(officialImage(idx.imageHost, bw, bw.parts[1], 12), "https://dz3we2x72f7ol.cloudfront.net/expansions/black-white/en-us/SV10pt5_RSV_EN_12.png");
});

test("a gallery-only set gets numbered cards in official sections", () => {
  const g = G("pitch-black"), p = g.parts[0];
  const s = gallerySet(idx.imageHost, g, p);
  assert.equal(s.id, "gallery:pitch-black");
  assert.equal(s.cards.length, 120);
  assert.equal(s.cards[0].name, "Card 001");
  assert.equal(s.cards[7].section, "Mega Evolution Pokémon"); // #8
  assert.equal(s.cards[97].section, "Special Art"); // #98 is both; Special Art wins
  assert.equal(s.sections[0], "Main Set");
  assert.ok(s.cards[0].image!.endsWith("KD5B_EN_1.png"));
});

test("with TCGdex data, ids and names come from the database", () => {
  const g = G("pitch-black"), p = g.parts[0];
  const db = { id: "me05", name: "Pitch Black", cardCount: { official: 84 }, cards: [{ id: "me05-001", localId: "001", name: "Bulbasaur", image: "https://assets.tcgdex.net/en/me/me05/001" }] };
  const s = gallerySet(idx.imageHost, g, p, db);
  assert.equal(s.id, "me05");
  assert.equal(s.cards[0].id, "me05-001");
  assert.equal(s.cards[0].name, "Bulbasaur");
  assert.equal(s.cards[0].number, "001/084");
  assert.equal(s.cards[1].name, "Card 002");
  assert.equal(s.cards[1].id, "me05-002");
  assert.equal(gallerySet(idx.imageHost, g, p, undefined, "me05").cards[0].id, "me05-001");
  // a binder started from the gallery keeps its ids, with the database id as ref
  const kept = gallerySet(idx.imageHost, g, p, db, "gallery:pitch-black");
  assert.equal(kept.cards[0].id, "g-001");
  assert.equal(kept.cards[0].ref, "me05-001");
  assert.equal(kept.cards[0].name, "Bulbasaur");
  assert.deepEqual(findPart(idx, "me05")?.g.slug, "pitch-black");
  assert.deepEqual(findPart(idx, "gallery:black-white:rsv-cards")?.p.label, "White Flare");
});

test("parses the official pages", () => {
  const index = `<a class="x" href="../../en-us/galleries/new-set/"><img src="https://cdn/x/me06.png" alt=""><span>Pokémon TCG: Mega Evolution&#8212;New Set</span></a>
    <a href="../../en-us/galleries/151/">Pokémon TCG: Scarlet &amp; Violet—151</a><a href="../../en-us/galleries/151/"><img src="https://cdn/sv03pt5.png"></a>`;
  assert.deepEqual(parseIndexPage(index), [
    { slug: "new-set", name: "Pokémon TCG: Mega Evolution—New Set", logo: "https://cdn/x/me06.png" },
    { slug: "151", name: "Pokémon TCG: Scarlet & Violet—151", logo: "https://cdn/sv03pt5.png" },
  ]);
  const page = `<title>Card Gallery | Pokémon TCG: Mega Evolution—Pitch Black</title><body class="a" data-asset-path="en-us/" data-tracking-expansion-name="me05">
    <button class="button__filter" data-controller="CardGalleryButton" data-filter="seeall" data-track-filter="See All">See All</button>
    <button data-controller="CardGalleryButton" data-filter="special-art" data-track-filter="Special Art"></button>
    <ul class="wrapper" data-controller="GalleryCards" data-expansion="pitch-black" data-expansion-id="KD5B" data-expansion-asset-path="me-expansions"></ul>
    <script src="../../../galleries/gallery.js"></script><script src="../../../galleries/pitch-black/index.js"></script>`;
  const p = parseGalleryPage(page);
  assert.equal(p.code, "me05");
  assert.deepEqual(p.roots, [{ expansion: "pitch-black", expansionId: "KD5B", assetPath: "me-expansions" }]);
  assert.deepEqual(p.filters, { seeall: "See All", "special-art": "Special Art" });
  assert.deepEqual(p.scripts, ["../../../galleries/pitch-black/index.js"]);
  assert.deepEqual(versionsFromScript(`st({rootSelector:".bw_page--black_bolt ",expCardVersion:"zsv-cards",customPath:"./"});st({rootSelector:".bw_page--white_flare ",expCardVersion:"rsv-cards",customPath:"./"});`), ["zsv-cards", "rsv-cards"]);
  const folders = idFoldersFromScript(`let i=["SV01","SV02","SV3pt5"],n=1`);
  assert.deepEqual(folders, ["SV01", "SV02", "SV3pt5"]);
  assert.equal(cardsJsonPath({ expansion: "151", expansionId: "SV3pt5", assetPath: "sv-expansions" }, "cards", folders), "/assets/img/sv-expansions/sv3pt5/cards/cards.json");
  assert.equal(cardsJsonPath(p.roots[0], "cards", folders), "/assets/img/me-expansions/pitch-black/cards/cards.json");
  assert.deepEqual(partFrom("cards", { seeall: [1, 2, 3, 4], ex: [2, 3] }), { version: "cards", count: 4, categories: { ex: "2-3" } });
});

test("matches TCGdex sets and merges a new gallery", () => {
  const db = [{ id: "sv10.5b", name: "Black Bolt" }, { id: "me02.5", name: "Ascended Heroes" }, { id: "sv03.5", name: "151" }];
  assert.equal(matchTcgdex("Black Bolt", db), "sv10.5b");
  assert.equal(matchTcgdex("151", db), "sv03.5");
  assert.equal(matchTcgdex("Brand New Set", db), null);
  const fresh = [...idx.galleries.map((g) => ({ ...g, firstSeen: "" })), { ...G("pitch-black"), slug: "new-set", name: "Pokémon TCG: Mega Evolution—New Set", firstSeen: "", parts: [{ ...G("pitch-black").parts[0], tcgdex: null }] }];
  const { index, added, changed } = mergeIndex(idx, fresh, "2026-11-20");
  assert.deepEqual(added, ["new-set"]);
  assert.deepEqual(changed, []);
  assert.equal(index.galleries.find((g) => g.slug === "new-set")!.firstSeen, "2026-11-20");
  assert.equal(index.galleries.find((g) => g.slug === "151")!.firstSeen, "2026-10-28");
  // a match found earlier isn't lost if today's TCGdex lookup fails
  const noDb = idx.galleries.map((g) => ({ ...g, parts: g.parts.map((p) => ({ ...p, tcgdex: null })) }));
  assert.equal(mergeIndex(idx, noDb, "2026-11-20").index.galleries.find((g) => g.slug === "151")!.parts[0].tcgdex, "sv03.5");
});
