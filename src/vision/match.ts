import { fingerprint, similarity, type Fingerprint, type RGBAImage } from "./features.ts";

export interface RefFingerprint extends Fingerprint {
  id: string;
}

export interface Match {
  id: string;
  score: number; // 0..1
  confidence: number; // 0..1, how clearly the winner beats the runner-up
}

/** Crop a sub-rectangle (fractions of the image) out of an RGBA image. */
export function crop(img: RGBAImage, x0: number, y0: number, x1: number, y1: number): RGBAImage {
  const sx = Math.max(0, Math.round(x0 * img.width));
  const sy = Math.max(0, Math.round(y0 * img.height));
  const w = Math.max(1, Math.min(img.width, Math.round(x1 * img.width)) - sx);
  const h = Math.max(1, Math.min(img.height, Math.round(y1 * img.height)) - sy);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((sy + y) * img.width + sx) * 4;
    out.set(img.data.subarray(from, from + w * 4), y * w * 4);
  }
  return { width: w, height: h, data: out };
}

/**
 * Rank reference cards against a photo of one card (already cropped to roughly the card).
 * The photo is fingerprinted at a few slightly different framings so that a loose or
 * tight crop still lines up with the references; each reference keeps its best score.
 */
export function identify(photo: RGBAImage, refs: RefFingerprint[], top = 5): Match[] {
  const framings = [
    [0, 0, 1, 1],
    [0.025, 0.02, 0.975, 0.98],
    [0.05, 0.04, 0.95, 0.96],
    [0.012, 0.01, 0.988, 0.99],
  ];
  const queries = framings.map(([a, b, c, d]) =>
    fingerprint(a === 0 ? photo : crop(photo, a, b, c, d)),
  );
  const scored = refs.map((r) => ({
    id: r.id,
    score: Math.max(...queries.map((q) => similarity(q, r))),
  }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]?.score ?? 0;
  const second = scored[1]?.score ?? 0;
  const margin = best - second;
  return scored.slice(0, top).map((s, i) => ({
    ...s,
    confidence: i === 0 ? Math.max(0, Math.min(1, margin / 0.08)) : 0,
  }));
}
