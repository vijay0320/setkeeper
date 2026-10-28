// Builds data/sets/<set>.fingerprints.json from the official card images.
// Usage: node scripts/precompute-fingerprints.ts [setId] [--cache dir]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fingerprint } from "../src/vision/features.ts";
import { loadSharp } from "./sharp.ts";

const sharp = loadSharp();
const setId = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "30th-celebration";
const ci = process.argv.indexOf("--cache");
const cache = ci > 0 ? process.argv[ci + 1] : ".cache/images";
const set = JSON.parse(readFileSync(`data/sets/${setId}.json`, "utf8"));
mkdirSync(cache, { recursive: true });

async function imageBytes(key: string): Promise<Buffer> {
  for (const ext of [".jpg", ".png"]) {
    const p = join(cache, key + ext);
    if (existsSync(p)) return readFileSync(p);
  }
  const res = await fetch(set.imageBase + key + set.imageSuffix);
  if (!res.ok) throw new Error(`${key}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(join(cache, key + ".png"), buf);
  return buf;
}

const out: Record<string, unknown> = {};
for (const card of set.cards) {
  if (!card.image) continue;
  const { data, info } = await sharp(await imageBytes(card.image))
    .flatten({ background: "#ffffff" })
    .resize({ width: 240 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  out[card.id] = fingerprint({ width: info.width, height: info.height, data });
}
writeFileSync(`data/sets/${setId}.fingerprints.json`, JSON.stringify(out));
console.log(`fingerprinted ${Object.keys(out).length} cards`);
