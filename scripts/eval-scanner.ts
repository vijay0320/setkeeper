// Measures card-recognition accuracy on simulated phone photos of every reference card.
// Each trial: rotate a few degrees, drop on a random table colour, crop with a loose/tight
// frame, shift white balance and brightness, blur, add a glare spot, JPEG-compress.
// Usage: node scripts/eval-scanner.ts [trialsPerCard]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { identify, type RefFingerprint } from "../src/vision/match.ts";
import { loadSharp } from "./sharp.ts";

const sharp = loadSharp();
const trials = Number(process.argv[2] ?? 3);
const set = JSON.parse(readFileSync("data/sets/30th-celebration.json", "utf8"));
const fps = JSON.parse(readFileSync("data/sets/30th-celebration.fingerprints.json", "utf8"));
const refs: RefFingerprint[] = Object.entries(fps).map(([id, f]: [string, any]) => ({ id, ...f }));
const cache = ".cache/images";

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const between = (a: number, b: number) => a + (b - a) * rnd();

async function simulate(file: string) {
  const W = 240, H = 335;
  const bg = { r: Math.round(between(20, 230)), g: Math.round(between(20, 230)), b: Math.round(between(20, 230)) };
  const angle = between(-5, 5);
  const pad = 60;
  let img = sharp(readFileSync(file)).resize(W, H).rotate(angle, { background: bg })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: bg });
  const rotated = await img.toBuffer({ resolveWithObject: true });
  const RW = rotated.info.width, RH = rotated.info.height;
  // user frames the card: centre jitter ±4%, scale 0.92..1.10 of the card size
  const s = between(0.92, 1.1);
  const cw = W * s, ch = H * s;
  const cx = RW / 2 + between(-0.04, 0.04) * W, cy = RH / 2 + between(-0.04, 0.04) * H;
  const left = Math.max(0, Math.round(cx - cw / 2)), top = Math.max(0, Math.round(cy - ch / 2));
  const width = Math.min(RW - left, Math.round(cw)), height = Math.min(RH - top, Math.round(ch));
  const glareX = Math.round(between(0, width - 60)), glareY = Math.round(between(0, height - 60));
  const glare = Buffer.from(
    `<svg width="${width}" height="${height}"><defs><radialGradient id="g"><stop offset="0" stop-color="white" stop-opacity="${between(0.2, 0.6)}"/><stop offset="1" stop-color="white" stop-opacity="0"/></radialGradient></defs><ellipse cx="${glareX + 30}" cy="${glareY + 30}" rx="${between(20, 60)}" ry="${between(15, 45)}" fill="url(#g)"/></svg>`,
  );
  const jpg = await sharp(rotated.data)
    .extract({ left, top, width, height })
    .modulate({ brightness: between(0.75, 1.25), saturation: between(0.8, 1.2), hue: Math.round(between(-12, 12)) })
    .linear(between(0.85, 1.15), between(-15, 15))
    .blur(between(0.3, 1.4))
    .composite([{ input: glare }])
    .resize({ width: Math.round(between(300, 900)) })
    .jpeg({ quality: Math.round(between(55, 90)) })
    .toBuffer();
  const raw = await sharp(jpg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: raw.info.width, height: raw.info.height, data: raw.data };
}

let n = 0, top1 = 0, top3 = 0;
const misses: string[] = [];
const t0 = Date.now();
for (const card of set.cards) {
  if (!card.image) continue;
  const file = [".jpg", ".png"].map((e) => join(cache, card.image + e)).find(existsSync);
  if (!file) continue;
  for (let t = 0; t < trials; t++) {
    const photo = await simulate(file);
    const res = identify(photo, refs);
    n++;
    if (res[0].id === card.id) top1++;
    else misses.push(`${card.id} ${card.name} -> ${res[0].id}`);
    if (res.slice(0, 3).some((r) => r.id === card.id)) top3++;
  }
}
console.log(`trials=${n} top1=${((100 * top1) / n).toFixed(1)}% top3=${((100 * top3) / n).toFixed(1)}% ` +
  `avg ${((Date.now() - t0) / n).toFixed(0)}ms/scan`);
if (process.argv.includes("--misses")) console.log(misses.join("\n"));
void readdirSync;
