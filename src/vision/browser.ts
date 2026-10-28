// Browser-only helpers that turn photos into RGBA pixels for the vision code.
import type { RGBAImage } from "./features.ts";

export async function fileToCanvas(file: Blob, maxDim = 1000): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

export function canvasToRGBA(c: HTMLCanvasElement, x = 0, y = 0, w = c.width, h = c.height): RGBAImage {
  const d = c.getContext("2d", { willReadFrequently: true })!.getImageData(x, y, Math.max(1, w), Math.max(1, h));
  return { width: d.width, height: d.height, data: d.data };
}
