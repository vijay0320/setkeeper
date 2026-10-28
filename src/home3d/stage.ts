// Small WebGL scenes used in each tab's masthead and in the card viewer, so every page
// shares the home film's 3D cards. Each scene renders only while it's on screen.
import { Renderer, loadCardImage, CARD_W } from "./gl.ts";
import { compose, lookAt, multiply, perspective, lerp } from "./math.ts";

export interface StageCard { id: string; name: string; tex: string; foil: number; ghost?: boolean }

export type Scene =
  | { kind: "single"; card: StageCard; scan?: boolean; drag?: boolean }
  | { kind: "fan"; cards: StageCard[] }
  | { kind: "stack"; cards: StageCard[] }
  | { kind: "pack"; title: string; sub: string; color: string; cards: StageCard[] }
  | { kind: "grid"; cards: StageCard[] };

const live = new Set<() => void>();
/** Stop every running stage (called when the app switches tabs). */
export function stopStages() { for (const f of [...live]) f(); live.clear(); }

const texCache = new Map<string, HTMLImageElement | HTMLCanvasElement>();
async function image(c: StageCard) {
  if (!texCache.has(c.tex)) texCache.set(c.tex, await loadCardImage(c.tex, c.name));
  return texCache.get(c.tex)!;
}

function packArt(title: string, sub: string, color: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 820;
  const x = c.getContext("2d")!;
  const g = x.createLinearGradient(0, 0, 512, 820);
  g.addColorStop(0, color); g.addColorStop(0.55, "#1b1b22"); g.addColorStop(1, color);
  x.fillStyle = g; x.fillRect(0, 0, 512, 820);
  // crimped ends
  x.fillStyle = "rgba(255,255,255,0.18)";
  for (let i = 0; i < 512; i += 10) { x.fillRect(i, 0, 5, 46); x.fillRect(i, 774, 5, 46); }
  // foil rays
  x.save(); x.translate(256, 330);
  for (let i = 0; i < 36; i++) { x.rotate(Math.PI / 18); x.fillStyle = `rgba(255,255,255,${i % 2 ? 0.05 : 0.11})`; x.beginPath(); x.moveTo(0, 0); x.lineTo(-40, -520); x.lineTo(40, -520); x.fill(); }
  x.restore();
  x.beginPath(); x.arc(256, 330, 120, 0, Math.PI * 2); x.fillStyle = "rgba(255,255,255,0.16)"; x.fill();
  x.fillStyle = "#fff"; x.textAlign = "center";
  x.font = "italic 400 74px 'Instrument Serif', Georgia, serif"; x.fillText("30", 256, 352);
  x.font = "400 54px 'Instrument Serif', Georgia, serif";
  const words = title.split(" ");
  words.forEach((w, i) => x.fillText(w, 256, 560 + i * 58));
  x.font = "500 22px Archivo, Helvetica, Arial, sans-serif"; x.fillStyle = "rgba(255,255,255,0.75)";
  x.fillText(sub, 256, 700);
  return c;
}

export function stage(scene: Scene, cls = ""): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = `stage3d ${cls}`;
  const canvas = document.createElement("canvas");
  wrap.append(canvas);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let r: Renderer | null = null, raf = 0, visible = true, stopped = false;
  let mx = 0, my = 0, smx = 0, smy = 0, dragX = 0, dragY = 0, dragging = false, vx = 0;
  const texs: WebGLTexture[] = [];
  let extra: WebGLTexture | null = null;

  const onMove = (e: PointerEvent) => {
    const b = wrap.getBoundingClientRect();
    mx = ((e.clientX - b.left) / b.width) * 2 - 1;
    my = ((e.clientY - b.top) / b.height) * 2 - 1;
  };
  addEventListener("pointermove", onMove, { passive: true });
  if (scene.kind === "single" && scene.drag) {
    wrap.classList.add("draggable");
    let sx = 0, sy = 0;
    wrap.addEventListener("pointerdown", (e) => { dragging = true; sx = e.clientX; sy = e.clientY; wrap.setPointerCapture(e.pointerId); });
    wrap.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = (e.clientX - sx) / 120, dy = (e.clientY - sy) / 160;
      vx = dx; dragX += dx; dragY = Math.max(-0.7, Math.min(0.7, dragY + dy)); sx = e.clientX; sy = e.clientY;
    });
    const up = () => (dragging = false);
    wrap.addEventListener("pointerup", up); wrap.addEventListener("pointercancel", up);
  }
  const io = new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible && !raf && !stopped) raf = requestAnimationFrame(frame); }, { rootMargin: "80px" });

  const cards = scene.kind === "single" ? [scene.card] : scene.cards;
  const t0 = performance.now();
  let last = t0;

  function frame(now: number) {
    raf = 0;
    if (stopped || !r) return;
    if (!visible) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const t = reduce ? 0 : (now - t0) / 1000;
    smx = lerp(smx, mx, 1 - Math.pow(0.03, dt)); smy = lerp(smy, my, 1 - Math.pow(0.03, dt));
    if (!dragging) { vx *= Math.pow(0.05, dt); dragX += vx * dt * 4; }
    const aspect = r.resize();
    const camZ = scene.kind === "grid" ? 5.6 : scene.kind === "fan" || scene.kind === "stack" ? 2.7 : aspect < 0.8 ? 1.75 : 2.2;
    const cam = [smx * 0.05, -smy * 0.04, camZ];
    const vp = multiply(perspective(aspect < 0.8 ? 0.85 : 0.6, aspect, 0.05, 30), lookAt(cam, [0, 0, 0]));
    r.begin(vp, cam, [1.4, 2.2, 3], t);
    const T = (i: number) => texs[i] ?? texs[0];
    if (!texs.length) return;

    if (scene.kind === "single") {
      const c = scene.card;
      const ry = dragX + (scene.drag ? 0 : -0.3 + smx * 0.45 + Math.sin(t * 0.6) * 0.08);
      const rx = dragY + (scene.drag ? smy * 0.05 : 0.1 + smy * 0.25);
      const scan = scene.scan ? ((t * 0.35) % 1.4) : 0;
      r.draw({ model: compose([0, Math.sin(t * 0.8) * 0.02, 0], [rx, ry, scene.drag ? 0 : -0.06], 1.65), tex: T(0), foil: c.foil, ghost: c.ghost ? 0.85 : 0, scan: scan > 0 && scan < 1 ? 1 - scan : 0 });
    } else if (scene.kind === "fan") {
      const n = cards.length;
      cards.forEach((c, i) => {
        const k = n === 1 ? 0 : i / (n - 1) - 0.5;
        const sway = Math.sin(t * 0.7 + i) * 0.02;
        r!.draw({ model: compose([k * 1.15 + smx * 0.08, -Math.abs(k) * 0.35 + 0.08 + sway, i * 0.02], [0.08 + smy * 0.15, -0.25 + smx * 0.35 + k * 0.2, -k * 0.55], 1.25), tex: T(i), foil: c.foil, ghost: c.ghost ? 0.85 : 0 });
      });
    } else if (scene.kind === "stack") {
      cards.forEach((c, i) => {
        const a = i * 0.45 + t * 0.12;
        r!.draw({ model: compose([Math.sin(a) * 0.12 + (i - (cards.length - 1) / 2) * 0.32, (i - (cards.length - 1) / 2) * -0.06, i * 0.06], [0.25 + smy * 0.15, -0.5 + smx * 0.35 + i * 0.12, -0.12 + i * 0.09], 1.15), tex: T(i), foil: c.foil });
      });
    } else if (scene.kind === "pack") {
      const peek = (Math.sin(t * 0.8) * 0.5 + 0.5) * 0.18;
      cards.slice(0, 3).forEach((c, i) => {
        r!.draw({ model: compose([0.05 + (i - 1) * 0.16, 0.42 + peek + i * 0.05, -0.05 - i * 0.02], [0.05, -0.3 + smx * 0.3, (i - 1) * 0.18], 1.0), tex: T(i), foil: c.foil });
      });
      r.draw({ model: compose([0, -0.05, 0.08], [0.06 + smy * 0.2, -0.3 + smx * 0.4 + Math.sin(t * 0.5) * 0.06, -0.04], [1.25, 1.35, 3]), tex: extra!, foil: 1 });
    } else if (scene.kind === "grid") {
      const cols = 6, rows = Math.ceil(cards.length / cols);
      cards.forEach((c, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        const x = (col - (cols - 1) / 2) * CARD_W * 1.12, y = ((rows - 1) / 2 - row) * 0.98;
        r!.draw({ model: compose([x, y, 0], [-0.35 + smy * 0.1, 0.25 + smx * 0.2, 0.05], 1), tex: T(i), foil: c.foil * 0.6, ghost: c.ghost ? 0.9 : 0 });
      });
    }
  }

  requestAnimationFrame(async () => {
    if (!wrap.isConnected) return;
    try { r = new Renderer(canvas); } catch { wrap.classList.add("no-gl"); return; }
    const imgs = await Promise.all(cards.map(image));
    if (stopped) return;
    for (const im of imgs) texs.push(r.textureFromCanvas(im));
    if (scene.kind === "pack") extra = r.textureFromCanvas(packArt(scene.title, scene.sub, scene.color));
    wrap.classList.add("ready");
    io.observe(wrap);
    raf = requestAnimationFrame(frame);
  });

  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    io.disconnect();
    removeEventListener("pointermove", onMove);
    r?.destroy();
    live.delete(stop);
  };
  live.add(stop);
  return wrap;
}
