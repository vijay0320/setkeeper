import { resample, type RGBAImage } from "./features.ts";

/** Edge positions as fractions of the image width/height. */
export interface Edges {
  outer: { left: number; right: number; top: number; bottom: number };
  inner: { left: number; right: number; top: number; bottom: number };
  confidence: number; // 0..1 from edge strength
}

export interface Centering {
  leftRight: [number, number]; // e.g. [55, 45] percent
  topBottom: [number, number];
  worst: number; // larger share of the worse axis, e.g. 55
  psa: string; // best PSA grade centering allows
  bgs: string;
  cgc: string;
}

function grayGrid(img: RGBAImage, maxDim = 480) {
  const s = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(16, Math.round(img.width * s));
  const h = Math.max(16, Math.round(img.height * s));
  const rgb = resample(img, w, h);
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  return { g, w, h, rgb };
}

/** Sum of absolute colour differences between neighbours, projected onto one axis. */
function profile(rgb: Float32Array, w: number, h: number, axis: "x" | "y", band = [0.3, 0.7]): Float32Array {
  const len = axis === "x" ? w : h;
  const p = new Float32Array(len);
  if (axis === "x") {
    for (let y = Math.floor(h * band[0]); y < Math.ceil(h * band[1]); y++)
      for (let x = 1; x < w; x++) {
        const a = (y * w + x) * 3, b = a - 3;
        p[x] += Math.abs(rgb[a] - rgb[b]) + Math.abs(rgb[a + 1] - rgb[b + 1]) + Math.abs(rgb[a + 2] - rgb[b + 2]);
      }
  } else {
    for (let x = Math.floor(w * band[0]); x < Math.ceil(w * band[1]); x++)
      for (let y = 1; y < h; y++) {
        const a = (y * w + x) * 3, b = a - w * 3;
        p[y] += Math.abs(rgb[a] - rgb[b]) + Math.abs(rgb[a + 1] - rgb[b + 1]) + Math.abs(rgb[a + 2] - rgb[b + 2]);
      }
  }
  // light smoothing
  const s = new Float32Array(len);
  for (let i = 0; i < len; i++) s[i] = (p[i - 1] ?? p[i]) * 0.25 + p[i] * 0.5 + (p[i + 1] ?? p[i]) * 0.25;
  return s;
}

function argmax(p: Float32Array, from: number, to: number): [number, number] {
  let bi = Math.max(0, from), bv = -1;
  for (let i = Math.max(0, from); i <= Math.min(p.length - 1, to); i++) if (p[i] > bv) { bv = p[i]; bi = i; }
  return [bi, bv];
}

function mean(p: Float32Array): number {
  let s = 0;
  for (const v of p) s += v;
  return s / (p.length || 1);
}

/**
 * Find the card's outer edges and the inner border (where the coloured frame meets the card face).
 * Works on a photo of a single card on a contrasting background, or on a tight crop
 * of the card (then the image edge is treated as the card edge).
 */
export function detectEdges(img: RGBAImage): Edges {
  const { w, h, rgb } = grayGrid(img);
  const px = profile(rgb, w, h, "x");
  const py = profile(rgb, w, h, "y");
  const mx = mean(px) || 1, my = mean(py) || 1;

  // Outer edge: the first strong transition met when walking in from the image edge.
  const outerSide = (p: Float32Array, len: number, m: number, fromStart: boolean): [number, number] => {
    const zone = Math.floor(len * 0.3);
    const [, peak] = fromStart ? argmax(p, 1, zone) : argmax(p, len - 1 - zone, len - 2);
    if (peak < m * 2.2) return [fromStart ? 0 : len - 1, 1]; // tight crop: image edge is the card edge
    for (let k = 1; k <= zone; k++) {
      const i = fromStart ? k : len - 1 - k;
      const local = p[i] >= (p[i - 1] ?? 0) && p[i] >= (p[i + 1] ?? 0);
      if (local && p[i] >= peak * 0.55) return [i, p[i] / m];
    }
    return [fromStart ? 0 : len - 1, 1];
  };
  const [oL, sL] = outerSide(px, w, mx, true);
  const [oR, sR] = outerSide(px, w, mx, false);
  const [oT, sT] = outerSide(py, h, my, true);
  const [oB, sB] = outerSide(py, h, my, false);

  const at = (x: number, y: number) => (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 3;
  const dist = (i: number, c: number[]) => Math.abs(rgb[i] - c[0]) + Math.abs(rgb[i + 1] - c[1]) + Math.abs(rgb[i + 2] - c[2]);
  const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };

  // Inner edge: walk inward along many scanlines from just inside the outer edge until the
  // colour leaves the frame colour; the median over scanlines is robust to art that touches the frame.
  const innerSide = (side: "l" | "r" | "t" | "b"): [number, number] => {
    const horiz = side === "l" || side === "r";
    const outer = { l: oL, r: oR, t: oT, b: oB }[side];
    const span = horiz ? oR - oL : oB - oT;
    const dir = side === "l" || side === "t" ? 1 : -1;
    const lo = horiz ? oT + (oB - oT) * 0.3 : oL + (oR - oL) * 0.3;
    const hi = horiz ? oT + (oB - oT) * 0.7 : oL + (oR - oL) * 0.7;
    const start = Math.max(1, Math.round(span * 0.008));
    const maxRun = Math.round(span * 0.15);
    const found: number[] = [];
    for (let s = Math.round(lo); s <= hi; s += Math.max(1, Math.round((hi - lo) / 40))) {
      const pos = (k: number) => (horiz ? at(outer + dir * k, s) : at(s, outer + dir * k));
      const ref = [0, 0, 0];
      const n0 = Math.max(2, Math.round(span * 0.006));
      for (let k = start; k < start + n0; k++) { const i = pos(k); ref[0] += rgb[i] / n0; ref[1] += rgb[i + 1] / n0; ref[2] += rgb[i + 2] / n0; }
      // the face must differ from the frame for several pixels in a row (skips thin print/text inside the frame)
      const run = Math.max(3, Math.round(span * 0.012));
      for (let k = start + n0; k <= maxRun; k++) {
        let ok = true;
        for (let j = 0; j < run && ok; j++) ok = dist(pos(k + j), ref) > 60;
        if (ok) { found.push(k); break; }
      }
    }
    if (found.length < 5) return [outer + dir * Math.round(span * 0.04), 0];
    const m = median(found);
    const agree = found.filter((k) => Math.abs(k - m) <= Math.max(1, span * 0.006)).length / found.length;
    return [outer + dir * m, agree];
  };
  const [iL, aL] = innerSide("l");
  const [iR, aR] = innerSide("r");
  const [iT, aT] = innerSide("t");
  const [iB, aB] = innerSide("b");

  const edgeOk = Math.min(sL, sR, sT, sB) > 1 ? 1 : 0.6;
  return {
    outer: { left: oL / w, right: oR / w, top: oT / h, bottom: oB / h },
    inner: { left: iL / w, right: iR / w, top: iT / h, bottom: iB / h },
    confidence: Math.round(Math.min(aL, aR, aT, aB) * edgeOk * 100) / 100,
  };
}

const PSA: [number, string][] = [[55, "10"], [60, "9"], [65, "8"], [70, "7"], [80, "6"], [85, "5"], [90, "3"]];
const BGS: [number, string][] = [[50.5, "10 Pristine"], [55, "9.5"], [60, "9"], [65, "8.5"], [70, "8"], [75, "7"], [80, "6"]];
const CGC: [number, string][] = [[50.5, "10 Pristine"], [55, "10"], [60, "9.5"], [62.5, "9"], [65, "8.5"], [70, "8"], [75, "7"]];

function cap(worst: number, table: [number, string][]): string {
  for (const [limit, grade] of table) if (worst <= limit + 1e-9) return grade;
  return "≤2";
}

/** Turn edge positions into centering ratios and the best grade each company would allow (front of card). */
export function centeringFrom(e: Edges): Centering {
  const l = e.inner.left - e.outer.left, r = e.outer.right - e.inner.right;
  const t = e.inner.top - e.outer.top, b = e.outer.bottom - e.inner.bottom;
  const lr = (100 * l) / (l + r || 1), tb = (100 * t) / (t + b || 1);
  const round = (x: number) => Math.round(x * 10) / 10;
  const worst = Math.max(lr, 100 - lr, tb, 100 - tb);
  return {
    leftRight: [round(lr), round(100 - lr)],
    topBottom: [round(tb), round(100 - tb)],
    worst: round(worst),
    psa: cap(worst, PSA),
    bgs: cap(worst, BGS),
    cgc: cap(worst, CGC),
  };
}
