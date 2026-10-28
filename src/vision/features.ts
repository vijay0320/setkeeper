// Card fingerprinting: pure TypeScript, runs identically in the browser and in Node.
// A fingerprint combines two perceptual hashes (art box + whole card), a small
// normalised grayscale thumbnail and a hue/saturation histogram of the art box.

export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array; // RGBA, row-major
}

export interface Fingerprint {
  art: string; // 64-bit pHash of the art box, hex
  full: string; // 64-bit pHash of the whole card, hex
  thumb: number[]; // 12x16 grayscale, zero-mean / unit-variance, quantised to int8
  hist: number[]; // 24 hue/sat bins + 4 gray bins, L1-normalised, quantised to 0..255
}

/** Fraction of the card occupied by the illustration window on a standard card. */
export const ART_BOX = { x0: 0.08, x1: 0.92, y0: 0.1, y1: 0.52 };

/** Area-average resample of a region into a w×h grid of RGB floats. */
export function resample(
  img: RGBAImage,
  w: number,
  h: number,
  region = { x0: 0, x1: 1, y0: 0, y1: 1 },
): Float32Array {
  const out = new Float32Array(w * h * 3);
  const rx0 = region.x0 * img.width;
  const ry0 = region.y0 * img.height;
  const rw = (region.x1 - region.x0) * img.width;
  const rh = (region.y1 - region.y0) * img.height;
  for (let gy = 0; gy < h; gy++) {
    const sy0 = Math.floor(ry0 + (gy * rh) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(ry0 + ((gy + 1) * rh) / h));
    for (let gx = 0; gx < w; gx++) {
      const sx0 = Math.floor(rx0 + (gx * rw) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(rx0 + ((gx + 1) * rw) / w));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = sy0; y < sy1 && y < img.height; y++) {
        let i = (y * img.width + sx0) * 4;
        for (let x = sx0; x < sx1 && x < img.width; x++, i += 4) {
          r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
        }
      }
      const o = (gy * w + gx) * 3;
      n = n || 1;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return out;
}

function toGray(rgb: Float32Array): Float32Array {
  const g = new Float32Array(rgb.length / 3);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  return g;
}

const DCT_N = 32;
const COS = (() => {
  const t = new Float32Array(DCT_N * DCT_N);
  for (let k = 0; k < DCT_N; k++)
    for (let n = 0; n < DCT_N; n++) t[k * DCT_N + n] = Math.cos((Math.PI / DCT_N) * (n + 0.5) * k);
  return t;
})();

/** 64-bit perceptual hash (DCT of a 32×32 gray image, 8×8 low frequencies vs median). */
export function phash(gray32: Float32Array): string {
  const N = DCT_N;
  const tmp = new Float32Array(8 * N);
  for (let k = 0; k < 8; k++)
    for (let y = 0; y < N; y++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += gray32[y * N + x] * COS[k * N + x];
      tmp[k * N + y] = s;
    }
  const coef: number[] = [];
  for (let ky = 0; ky < 8; ky++)
    for (let kx = 0; kx < 8; kx++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += tmp[kx * N + y] * COS[ky * N + y];
      coef.push(s);
    }
  const ac = coef.slice(1);
  const median = [...ac].sort((a, b) => a - b)[Math.floor(ac.length / 2)];
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    let nib = 0;
    for (let j = 0; j < 4; j++) nib = (nib << 1) | (i + j > 0 && coef[i + j] > median ? 1 : 0);
    hex += nib.toString(16);
  }
  return hex;
}

function normalise(v: Float32Array): number[] {
  let m = 0;
  for (const x of v) m += x;
  m /= v.length;
  let s = 0;
  for (const x of v) s += (x - m) ** 2;
  s = Math.sqrt(s / v.length) || 1;
  return Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(((x - m) / s) * 40))));
}

function hsHist(rgb: Float32Array): number[] {
  const bins = new Float32Array(28);
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i] / 255, g = rgb[i + 1] / 255, b = rgb[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    const sat = mx === 0 ? 0 : d / mx;
    if (sat < 0.18 || mx < 0.12) {
      bins[24 + Math.min(3, Math.floor(mx * 4))] += 1; // achromatic: 4 brightness bins
      continue;
    }
    let h = 0;
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    bins[Math.floor(h / 30) * 2 + (sat > 0.55 ? 1 : 0)] += 1;
  }
  const total = bins.reduce((a, b) => a + b, 0) || 1;
  return Array.from(bins, (x) => Math.round((x / total) * 255));
}

export function fingerprint(card: RGBAImage): Fingerprint {
  const artRgb = resample(card, DCT_N, DCT_N, ART_BOX);
  const fullGray = toGray(resample(card, DCT_N, DCT_N));
  const thumb = toGray(resample(card, 12, 16));
  const histRgb = resample(card, 24, 16, ART_BOX);
  return { art: phash(toGray(artRgb)), full: phash(fullGray), thumb: normalise(thumb), hist: hsHist(histRgb) };
}

// ---------- similarity ----------

const POP = Array.from({ length: 16 }, (_, i) => (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1));
export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POP[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return d;
}

function corr(a: number[], b: number[]): number {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return s / (Math.sqrt(na * nb) || 1);
}

function histIntersect(a: number[], b: number[]): number {
  let s = 0, t = 0;
  for (let i = 0; i < a.length; i++) { s += Math.min(a[i], b[i]); t += a[i]; }
  return s / (t || 1);
}

export const WEIGHTS = { art: 0.3, full: 0.15, thumb: 0.35, hist: 0.2 };

/** Similarity in 0..1 (1 = identical fingerprints). */
export function similarity(a: Fingerprint, b: Fingerprint, w = WEIGHTS): number {
  return (
    w.art * (1 - hamming(a.art, b.art) / 32) +
    w.full * (1 - hamming(a.full, b.full) / 32) +
    w.thumb * corr(a.thumb, b.thumb) +
    w.hist * histIntersect(a.hist, b.hist)
  );
}
