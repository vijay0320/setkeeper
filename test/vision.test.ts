import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fingerprint, similarity, hamming, type RGBAImage } from "../src/vision/features.ts";
import { identify } from "../src/vision/match.ts";
import { detectEdges, centeringFrom } from "../src/vision/centering.ts";

// Synthetic "card": coloured frame, a patterned face, on a dark table.
function synthCard(opts: { seed: number; left: number; right: number; top: number; bottom: number; pad?: number }): RGBAImage {
  const W = 252, H = 352, pad = opts.pad ?? 30;
  const w = W + pad * 2, h = H + pad * 2;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = 30, g = 34, b = 40; // table
      const cx = x - pad, cy = y - pad;
      if (cx >= 0 && cx < W && cy >= 0 && cy < H) {
        [r, g, b] = [235, 205, 90]; // frame
        if (cx >= opts.left && cx < W - opts.right && cy >= opts.top && cy < H - opts.bottom) {
          const s = opts.seed;
          r = 128 + 100 * Math.sin((cx * (s + 1)) / 23 + s);
          g = 128 + 100 * Math.cos((cy * (s + 2)) / 31);
          b = 128 + 90 * Math.sin((cx + cy) / (7 + s));
        }
      }
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  return { width: w, height: h, data: d };
}

test("fingerprints are stable and distinguish cards", () => {
  const a = synthCard({ seed: 1, left: 12, right: 12, top: 12, bottom: 12 });
  const b = synthCard({ seed: 4, left: 12, right: 12, top: 12, bottom: 12 });
  const fa = fingerprint(a), fb = fingerprint(b);
  assert.equal(hamming(fa.art, fingerprint(a).art), 0);
  assert.ok(similarity(fa, fa) > 0.99);
  assert.ok(similarity(fa, fb) < similarity(fa, fa) - 0.2);
});

test("identify picks the matching reference", () => {
  const refs = [1, 2, 3, 4, 5].map((s) => ({ id: "c" + s, ...fingerprint(synthCard({ seed: s, left: 12, right: 12, top: 12, bottom: 12, pad: 0 })) }));
  const photo = synthCard({ seed: 3, left: 12, right: 12, top: 12, bottom: 12, pad: 0 });
  assert.equal(identify(photo, refs)[0].id, "c3");
});

test("centering detects a miscut card", () => {
  const e = detectEdges(synthCard({ seed: 2, left: 8, right: 16, top: 12, bottom: 12 }));
  const c = centeringFrom(e);
  assert.ok(Math.abs(c.leftRight[0] - 33.3) < 3, `left/right ${c.leftRight}`);
  assert.ok(Math.abs(c.topBottom[0] - 50) < 3, `top/bottom ${c.topBottom}`);
  assert.equal(c.psa, "7");
});

test("perfectly centred card allows a 10", () => {
  const c = centeringFrom(detectEdges(synthCard({ seed: 5, left: 12, right: 12, top: 14, bottom: 14 })));
  assert.equal(c.psa, "10");
});

test("reference fingerprints cover every card image", () => {
  const fp = JSON.parse(readFileSync(new URL("../data/sets/30th-celebration.fingerprints.json", import.meta.url), "utf8"));
  assert.equal(Object.keys(fp).length, 188);
});
