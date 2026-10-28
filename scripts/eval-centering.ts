// Checks the centering detector on simulated photos: each official image is placed on a
// table colour, optionally "miscut" (content shifted inside the frame), and measured.
// Reports outer-edge error and how closely the measured left/right ratio follows the shift.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { detectEdges, centeringFrom } from "../src/vision/centering.ts";
import { loadSharp } from "./sharp.ts";

const sharp = loadSharp();
const set = JSON.parse(readFileSync("data/sets/30th-celebration.json", "utf8"));
const cards = set.cards.filter((c: any) => c.image && ["Regular", "Double Rare (ex)", "Pikachu Rare"].includes(c.rarity));

async function place(card: Buffer, bg: { r: number; g: number; b: number }) {
  const pad = 40;
  const buf = await sharp(card).extend({ top: pad, bottom: pad, left: pad, right: pad, background: bg }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  return { width: buf.info.width, height: buf.info.height, data: buf.data };
}

// Re-cut a card: paint the face area with the frame colour, then paste the face back shifted by k px.
async function miscut(card: Buffer, face: { left: number; top: number; width: number; height: number }, k: number) {
  const raw = await sharp(card).raw().toBuffer({ resolveWithObject: true });
  const i = (Math.round(raw.info.height / 2) * raw.info.width + 3) * raw.info.channels;
  const frame = { r: raw.data[i], g: raw.data[i + 1], b: raw.data[i + 2] };
  const faceBuf = await sharp(card).extract(face).toBuffer();
  const fill = await sharp({ create: { width: face.width, height: face.height, channels: 3, background: frame } }).png().toBuffer();
  return sharp(card).composite([
    { input: fill, left: face.left, top: face.top },
    { input: faceBuf, left: face.left - k, top: face.top },
  ]).png().toBuffer();
}

let outerErr = 0, n = 0, trackErr = 0, tracked = 0, lowConf = 0;
const bg = { r: 40, g: 70, b: 60 };
for (const c of cards) {
  const file = [".jpg", ".png"].map((e) => join(".cache/images", c.image + e)).find(existsSync);
  if (!file) continue;
  const card = await sharp(readFileSync(file)).resize(240, 335).flatten({ background: bg }).png().toBuffer();
  const img0 = await place(card, bg);
  const e0 = detectEdges(img0);
  const W = img0.width, H = img0.height;
  outerErr += Math.abs(e0.outer.left * W - 40) + Math.abs(e0.outer.right * W - 279);
  n += 2;
  if (e0.confidence < 0.5) { lowConf++; continue; }
  const L0 = Math.round((e0.inner.left - e0.outer.left) * W), R0 = Math.round((e0.outer.right - e0.inner.right) * W);
  const face = { left: L0, top: Math.round((e0.inner.top - e0.outer.top) * H), width: 240 - L0 - R0,
    height: Math.round((e0.inner.bottom - e0.inner.top) * H) };
  for (const k of [2, 4]) {
    const c1 = centeringFrom(detectEdges(await place(await miscut(card, face, k), bg)));
    trackErr += Math.abs(c1.leftRight[0] - (100 * (L0 - k)) / (L0 + R0));
    tracked++;
  }
}
console.log(`cards=${cards.length} outer-edge error=${(outerErr / n).toFixed(2)}px lowConfidence=${lowConf} ` +
  `miscut L/R tracking error=${(trackErr / tracked).toFixed(2)} pts over ${tracked} cuts`);
