// A real zip binder in WebGL.
// Pull the zipper and it runs around the cover; the cover swings open on its spine.
// Pages are stiff side-loading sleeves: they bow as they turn, catch the light, cast a
// shadow on the page below and land with a soft thud. Drag a page by its edge to turn it
// at your own speed, flick it, use the arrow keys, or jump to a section and the pages
// riffle past. Tap a pocket to open that card.
import { compose, lookAt, multiply, perspective, lerp, clamp01, invert, rayFrom, easeInOut, type Mat4 } from "./math.ts";
import type { Material } from "../lib/binders.ts";

export type PocketItem =
  | { kind: "card"; name: string; number: string; image: string; owned: boolean; status?: string }
  | { kind: "add" };

export interface Binder3DOptions {
  key: string;
  title: string;
  subtitle: string;
  logo?: string;
  color: string;
  material: Material;
  cols: number;
  rows: number;
  items: PocketItem[];
  owner?: string;
  progress?: { have: number; total: number };
  jumps?: { label: string; page: number }[];
  onCard: (index: number) => void;
  onAdd?: () => void;
}

// ------------------------------------------------------------------ shaders
const SHEET_VS = `#version 300 es
in vec2 aUv;
uniform mat4 uVP, uModel;
uniform float uTheta, uC, uW, uH, uY;
out vec2 vUv; out vec3 vPos; out vec3 vN;
void main() {
  float u = aUv.x, v = aUv.y;
  float a = uTheta + uC * u;
  vec3 p;
  if (abs(uC) < 1e-3) p = vec3(u * uW * cos(uTheta), u * uW * sin(uTheta), 0.0);
  else p = vec3(uW / uC * (sin(a) - sin(uTheta)), uW / uC * (cos(uTheta) - cos(a)), 0.0);
  p.z = (v - 0.5) * uH;
  p.y += uY;
  vec4 w = uModel * vec4(p, 1.0);
  vPos = w.xyz; vUv = aUv;
  vN = normalize(mat3(uModel) * vec3(-sin(a), cos(a), 0.0));
  gl_Position = uVP * w;
}`;

const SHEET_FS = `#version 300 es
precision highp float;
in vec2 vUv; in vec3 vPos; in vec3 vN;
uniform sampler2D uFront, uBack;
uniform vec3 uCam, uLight;
uniform float uGloss, uShadow, uShadowExt, uLeather;
out vec4 frag;
void main() {
  vec3 V = normalize(uCam - vPos);
  bool front = dot(vN, V) >= 0.0;
  vec3 N = front ? vN : -vN;
  vec3 base = front ? texture(uFront, vec2(vUv.x, 1.0 - vUv.y)).rgb : texture(uBack, vec2(1.0 - vUv.x, 1.0 - vUv.y)).rgb;
  vec3 L = normalize(uLight);
  vec3 H = normalize(L + V);
  float diff = 0.66 + 0.42 * max(dot(N, L), 0.0);
  float ao = mix(0.5, 1.0, smoothstep(0.0, 0.07, vUv.x)) * mix(0.82, 1.0, smoothstep(1.0, 0.94, vUv.x));
  float sh = 1.0 - uShadow * (1.0 - smoothstep(0.0, max(uShadowExt, 0.001), vUv.x));
  vec3 col = base * diff * ao * sh;
  float nh = max(dot(N, H), 0.0);
  float spec = pow(nh, 110.0) * 0.6 + pow(nh, 14.0) * 0.07;
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0) * 0.22;
  col += (spec + fres) * uGloss * vec3(1.0, 0.99, 0.97);
  col += pow(nh, 7.0) * 0.07 * uLeather;
  frag = vec4(col, 1.0);
}`;

const BOX_VS = `#version 300 es
in vec3 aPos; in vec3 aNormal;
uniform mat4 uVP, uModel;
out vec3 vN; out vec3 vPos;
void main() { vec4 w = uModel * vec4(aPos, 1.0); vPos = w.xyz; vN = normalize(mat3(uModel) * aNormal); gl_Position = uVP * w; }`;
const BOX_FS = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vPos;
uniform vec3 uColor, uLight, uCam;
uniform float uSheen;
out vec4 frag;
void main() {
  vec3 N = normalize(vN), L = normalize(uLight), V = normalize(uCam - vPos), H = normalize(L + V);
  float d = 0.55 + 0.5 * max(dot(N, L), 0.0);
  frag = vec4(uColor * d + pow(max(dot(N, H), 0.0), 20.0) * uSheen, 1.0);
}`;

const live = new Set<() => void>();
/** Stop every running binder (called when the app switches tabs). */
export function stopBinders() { for (const f of [...live]) f(); live.clear(); }

// ------------------------------------------------------------------ sound
let actx: AudioContext | null = null;
const muteKey = "setkeeper:binder-sound";
export function soundOn(): boolean { try { return localStorage.getItem(muteKey) !== "off"; } catch { return true; } }
function setSound(on: boolean) { try { localStorage.setItem(muteKey, on ? "on" : "off"); } catch { /* ignore */ } }
function audio(): AudioContext | null {
  if (!soundOn()) return null;
  try { actx ??= new AudioContext(); if (actx.state === "suspended") void actx.resume(); return actx; } catch { return null; }
}
function noise(ctx: AudioContext, secs: number) {
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * secs), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource(); s.buffer = b; return s;
}
/** Plastic sleeve swish. */
function swish(speed = 1) {
  const ctx = audio(); if (!ctx) return;
  const t = ctx.currentTime, dur = 0.32 / Math.max(0.5, speed);
  const src = noise(ctx, dur + 0.05);
  const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 0.8;
  bp.frequency.setValueAtTime(900, t); bp.frequency.exponentialRampToValueAtTime(3800, t + dur);
  const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16, t + dur * 0.35); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp).connect(g).connect(ctx.destination); src.start(t); src.stop(t + dur + 0.05);
}
/** Page settling onto the stack. */
function thud(vol = 1) {
  const ctx = audio(); if (!ctx) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(); o.type = "sine"; o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(60, t + 0.09);
  const g = ctx.createGain(); g.gain.setValueAtTime(0.12 * vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  const n = noise(ctx, 0.05); const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 900;
  const g2 = ctx.createGain(); g2.gain.setValueAtTime(0.08 * vol, t); g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  o.connect(g).connect(ctx.destination); n.connect(lp).connect(g2).connect(ctx.destination);
  o.start(t); o.stop(t + 0.13); n.start(t); n.stop(t + 0.06);
}
/** Zipper teeth: a quick run of tiny clicks. */
function zipSound(dur: number) {
  const ctx = audio(); if (!ctx) return;
  const t0 = ctx.currentTime;
  for (let i = 0, t = 0; t < dur; i++, t += 0.022 + Math.random() * 0.012) {
    const n = noise(ctx, 0.008); const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 3200 + Math.random() * 1800; bp.Q.value = 3;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.09 + Math.random() * 0.05, t0 + t); g.gain.exponentialRampToValueAtTime(0.0001, t0 + t + 0.008);
    n.connect(bp).connect(g).connect(ctx.destination); n.start(t0 + t); n.stop(t0 + t + 0.01);
  }
}

// ------------------------------------------------------------------ textures
const imgCache = new Map<string, Promise<HTMLImageElement | null>>();
function loadImg(url: string): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  if (!imgCache.has(url)) imgCache.set(url, new Promise((res) => {
    const i = new Image(); i.crossOrigin = "anonymous"; i.decoding = "async";
    i.onload = () => res(i); i.onerror = () => res(null); i.src = url;
  }));
  return imgCache.get(url)!;
}
function grain(x: CanvasRenderingContext2D, w: number, h: number, n: number, a: number, light = true) {
  for (let i = 0; i < n; i++) { x.fillStyle = light ? `rgba(255,255,255,${Math.random() * a})` : `rgba(0,0,0,${Math.random() * a})`; x.fillRect(Math.random() * w, Math.random() * h, 1.6, 1.6); }
}
const shade = (hex: string, k: number) => {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c * k)));
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
};

interface Layout { W: number; H: number; px: number; py: number; pockets: { x: number; y: number; w: number; h: number }[] }
function layoutFor(cols: number, rows: number): Layout {
  const W = 1, m = 0.05, g = 0.022;
  const pw = (W - 2 * m - (cols - 1) * g) / cols, ph = (pw * 88) / 63 + 0.012;
  const H = 2 * m + rows * ph + (rows - 1) * g;
  const pockets = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
    pockets.push({ x: (m + c * (pw + g)) / W, y: (m + r * (ph + g)) / H, w: pw / W, h: ph / H });
  return { W, H, px: 1024, py: Math.round((1024 * H) / W), pockets };
}

// ------------------------------------------------------------------ component
export function binder3d(o: Binder3DOptions): HTMLElement | null {
  const wrap = document.createElement("div");
  wrap.className = "binder3d";
  const canvas = document.createElement("canvas");
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", `${o.title} binder. Left and right arrow keys turn pages; Enter opens the binder.`);
  const bar = document.createElement("div");
  bar.className = "b3-bar";
  wrap.append(canvas, bar);

  const gl = canvas.getContext("webgl2", { antialias: true, alpha: true });
  if (!gl) return null;
  const prog = (vs: string, fs: string) => {
    const mk = (t: number, src: string) => { const s = gl.createShader(t)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? ""); return s; };
    const p = gl.createProgram()!; gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "");
    return p;
  };
  let sheetP: WebGLProgram, boxP: WebGLProgram;
  try { sheetP = prog(SHEET_VS, SHEET_FS); boxP = prog(BOX_VS, BOX_FS); } catch { return null; }
  const U = (p: WebGLProgram, names: string[]) => Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)]));
  const su = U(sheetP, ["uVP", "uModel", "uTheta", "uC", "uW", "uH", "uY", "uFront", "uBack", "uCam", "uLight", "uGloss", "uShadow", "uShadowExt", "uLeather"]);
  const bu = U(boxP, ["uVP", "uModel", "uColor", "uLight", "uCam", "uSheen"]);

  // sheet mesh: 48 segments along the page width
  const SEG = 48;
  const uv: number[] = [];
  for (let i = 0; i < SEG; i++) {
    const a = i / SEG, b = (i + 1) / SEG;
    uv.push(a, 0, b, 0, b, 1, a, 0, b, 1, a, 1);
  }
  const sheetVao = gl.createVertexArray()!;
  gl.bindVertexArray(sheetVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uv), gl.STATIC_DRAW);
  const uvLoc = gl.getAttribLocation(sheetP, "aUv");
  gl.enableVertexAttribArray(uvLoc); gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);
  // unit box (0..1 on each axis)
  const bv: number[] = [];
  const face = (n: number[], pts: number[][]) => { for (const i of [0, 1, 2, 0, 2, 3]) bv.push(...pts[i], ...n); };
  face([0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]);
  face([0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]);
  face([0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]);
  face([0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]);
  face([1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]);
  face([-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]);
  const boxVao = gl.createVertexArray()!;
  gl.bindVertexArray(boxVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(bv), gl.STATIC_DRAW);
  const pl = gl.getAttribLocation(boxP, "aPos"), nl = gl.getAttribLocation(boxP, "aNormal");
  gl.enableVertexAttribArray(pl); gl.vertexAttribPointer(pl, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(nl); gl.vertexAttribPointer(nl, 3, gl.FLOAT, false, 24, 12);
  gl.bindVertexArray(null);
  gl.enable(gl.DEPTH_TEST);

  const tex = (src: TexImageSource, t?: WebGLTexture) => {
    const x = t ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, x);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const ext = gl.getExtension("EXT_texture_filter_anisotropic");
    if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    return x;
  };

  // ---------------------------------------------------------------- content
  const L = layoutFor(o.cols, o.rows);
  const per = o.cols * o.rows;
  const pages = Math.max(1, Math.ceil(o.items.length / per));
  const sheets = Math.ceil(pages / 2);
  const leafCount = sheets + 1; // leaf 0 is the front cover
  const COVER_W = L.W * 1.06, COVER_H = L.H * 1.07;
  const memKey = `b3:${o.key}`;
  const mem = (globalThis as unknown as Record<string, { open: boolean; f: number }>)[memKey] ??= { open: false, f: 0 };

  const leather = shade(o.color, 1);
  const leatherDark = shade(o.color, 0.62);

  /** Draw one page face; side "front" has the spine on the left. */
  function drawFace(pageNo: number, side: "front" | "back", onReady: () => void): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = L.px; c.height = L.py;
    const x = c.getContext("2d")!;
    const paint = (imgs: (HTMLImageElement | null)[]) => {
      x.clearRect(0, 0, c.width, c.height);
      const g = x.createLinearGradient(0, 0, c.width, c.height);
      g.addColorStop(0, "#17181c"); g.addColorStop(1, "#0d0e11");
      x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
      grain(x, c.width, c.height, 5000, 0.035);
      // binding edge stitched into the page
      const spineX = side === "front" ? 0 : c.width;
      const sg = x.createLinearGradient(spineX, 0, side === "front" ? 40 : c.width - 40, 0);
      sg.addColorStop(0, "rgba(0,0,0,0.6)"); sg.addColorStop(1, "rgba(0,0,0,0)");
      x.fillStyle = sg; x.fillRect(side === "front" ? 0 : c.width - 40, 0, 40, c.height);
      const start = (pageNo - 1) * per;
      L.pockets.forEach((p, i) => {
        const X = p.x * c.width, Y = p.y * c.height, Wp = p.w * c.width, Hp = p.h * c.height;
        const it = o.items[start + i];
        // pocket well
        x.fillStyle = "rgba(255,255,255,0.025)";
        rr(x, X, Y, Wp, Hp, 14); x.fill();
        if (it?.kind === "card") {
          const im = imgs[i];
          const cw = Wp - 14, ch = Hp - 14;
          x.save(); rr(x, X + 7, Y + 7, cw, ch, 16); x.clip();
          if (im) {
            if (!it.owned) { x.filter = "grayscale(1) brightness(0.55)"; x.globalAlpha = 0.35; }
            x.drawImage(im, X + 7, Y + 7, cw, ch);
            x.filter = "none"; x.globalAlpha = 1;
          } else { x.fillStyle = "#26282d"; x.fillRect(X, Y, Wp, Hp); }
          x.restore();
          if (!it.owned || !im) {
            x.fillStyle = "rgba(255,255,255,0.88)"; x.textAlign = "center"; x.textBaseline = "middle";
            x.font = `400 ${Math.round(Wp * 0.17)}px 'Instrument Serif', Georgia, serif`;
            x.fillText(it.number, X + Wp / 2, Y + Hp / 2);
            x.font = `500 ${Math.round(Wp * 0.075)}px Archivo, Helvetica, Arial, sans-serif`;
            x.fillStyle = "rgba(255,255,255,0.6)";
            x.fillText(it.status ?? it.name, X + Wp / 2, Y + Hp / 2 + Wp * 0.16);
          }
        } else if (it?.kind === "add") {
          x.setLineDash([10, 8]); x.strokeStyle = "rgba(255,255,255,0.35)"; x.lineWidth = 3;
          rr(x, X + 10, Y + 10, Wp - 20, Hp - 20, 12); x.stroke(); x.setLineDash([]);
          x.fillStyle = "rgba(255,255,255,0.8)"; x.textAlign = "center"; x.textBaseline = "middle";
          x.font = `400 ${Math.round(Wp * 0.16)}px 'Instrument Serif', Georgia, serif`;
          x.fillText("+ Add a card", X + Wp / 2, Y + Hp / 2);
        }
        // the sleeve: clear plastic with a bright edge, a soft sheen and the side-loading lip
        const sh = x.createLinearGradient(X, Y, X + Wp, Y + Hp);
        sh.addColorStop(0, "rgba(255,255,255,0.10)"); sh.addColorStop(0.45, "rgba(255,255,255,0.02)"); sh.addColorStop(1, "rgba(255,255,255,0.07)");
        x.fillStyle = sh; rr(x, X, Y, Wp, Hp, 14); x.fill();
        x.strokeStyle = "rgba(255,255,255,0.22)"; x.lineWidth = 2.5; rr(x, X, Y, Wp, Hp, 14); x.stroke();
        const lipX = side === "front" ? X + 4 : X + Wp - 10;
        x.fillStyle = "rgba(255,255,255,0.16)"; x.fillRect(lipX, Y + 14, 6, Hp - 28);
      });
      x.font = "500 18px Archivo, Helvetica, Arial, sans-serif"; x.fillStyle = "rgba(255,255,255,0.35)";
      x.textAlign = side === "front" ? "right" : "left"; x.textBaseline = "alphabetic";
      x.fillText(String(pageNo), side === "front" ? c.width - 26 : 26, c.height - 14);
    };
    const start = (pageNo - 1) * per;
    const urls = L.pockets.map((_, i) => { const it = o.items[start + i]; return it?.kind === "card" ? it.image : ""; });
    paint(urls.map(() => null));
    Promise.all(urls.map(loadImg)).then((imgs) => { if (imgs.some(Boolean)) { paint(imgs); onReady(); } });
    return c;
  }

  function coverCanvas(zip: number): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = 1024; c.height = Math.round((1024 * COVER_H) / COVER_W);
    const x = c.getContext("2d")!;
    const W = c.width, H = c.height;
    // leather / canvas / carbon
    x.fillStyle = leather; x.fillRect(0, 0, W, H);
    const lg = x.createRadialGradient(W * 0.3, H * 0.2, 10, W * 0.5, H * 0.5, W);
    lg.addColorStop(0, "rgba(255,255,255,0.14)"); lg.addColorStop(1, "rgba(0,0,0,0.28)");
    x.fillStyle = lg; x.fillRect(0, 0, W, H);
    if (o.material === "leather") { grain(x, W, H, 26000, 0.07, true); grain(x, W, H, 26000, 0.12, false); }
    else if (o.material === "canvas") { for (let i = 0; i < H; i += 3) { x.fillStyle = "rgba(0,0,0,0.12)"; x.fillRect(0, i, W, 1); } for (let i = 0; i < W; i += 3) { x.fillStyle = "rgba(255,255,255,0.05)"; x.fillRect(i, 0, 1, H); } }
    else { for (let i = -H; i < W; i += 12) { x.strokeStyle = "rgba(0,0,0,0.3)"; x.lineWidth = 5; x.beginPath(); x.moveTo(i, 0); x.lineTo(i + H, H); x.stroke(); } }
    // spine wrap
    const sp = x.createLinearGradient(0, 0, 70, 0); sp.addColorStop(0, "rgba(0,0,0,0.55)"); sp.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = sp; x.fillRect(0, 0, 70, H);
    // stitching
    x.setLineDash([16, 11]); x.strokeStyle = "rgba(226,173,72,0.75)"; x.lineWidth = 3.5;
    rr(x, 96, 74, W - 150, H - 148, 26); x.stroke(); x.setLineDash([]);
    // debossed title
    x.textAlign = "center"; x.textBaseline = "middle";
    const ty = H * 0.47;
    x.font = `400 ${Math.round(W * 0.095)}px 'Instrument Serif', Georgia, serif`;
    const words = o.title.split(" "); const lines: string[] = [];
    let cur = "";
    for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (x.measureText(t).width > W * 0.62 && cur) { lines.push(cur); cur = w; } else cur = t; }
    lines.push(cur);
    lines.forEach((ln, i) => {
      const y = ty + (i - (lines.length - 1) / 2) * W * 0.1;
      x.fillStyle = "rgba(0,0,0,0.45)"; x.fillText(ln, W / 2 + 21, y + 3);
      x.fillStyle = "rgba(255,255,255,0.10)"; x.fillText(ln, W / 2 + 19, y - 1);
      const gold = x.createLinearGradient(0, y - 60, 0, y + 30); gold.addColorStop(0, "#f3d58e"); gold.addColorStop(0.5, "#c9973f"); gold.addColorStop(1, "#e8c072");
      x.fillStyle = gold; x.fillText(ln, W / 2 + 20, y);
    });
    x.font = "500 26px Archivo, Helvetica, Arial, sans-serif"; x.fillStyle = "rgba(255,255,255,0.45)";
    x.fillText(o.subtitle, W / 2 + 20, ty + lines.length * W * 0.055 + 40);
    // zipper: tape along top, outer edge and bottom; teeth part behind the pull
    const t = 22, inset = 12;
    const segs = [[70, inset, W - inset, inset], [W - inset, inset, W - inset, H - inset], [W - inset, H - inset, 70, H - inset]];
    const lens = segs.map(([a, b, cc, d]) => Math.hypot(cc - a, d - b));
    const total = lens.reduce((p, q) => p + q, 0);
    let along = zip * total;
    let pull: number[] = [70, inset];
    segs.forEach(([a, b, cc, d], i) => {
      const len = lens[i], open = Math.max(0, Math.min(len, along)); along -= len;
      const ux = (cc - a) / len, uy = (d - b) / len, nx = -uy, ny = ux;
      // tape
      x.strokeStyle = "#16171a"; x.lineWidth = t; x.beginPath(); x.moveTo(a, b); x.lineTo(cc, d); x.stroke();
      // teeth
      for (let s = 0; s < len; s += 7) {
        const px = a + ux * s, py = b + uy * s;
        const gap = s < open ? 7 : 0;
        const side = (s / 7) % 2 < 1 ? 1 : -1;
        x.fillStyle = s < open ? "#9da1a8" : "#c9ccd1";
        x.fillRect(px + nx * (side * (3 + gap)) - 2.5, py + ny * (side * (3 + gap)) - 2.5, 5, 5);
      }
      if (open > 0 && open < len) pull = [a + ux * open, b + uy * open];
      if (open >= len) pull = [cc, d];
    });
    // pull tab
    x.save(); x.translate(pull[0], pull[1]);
    x.fillStyle = "#3a3d43"; rr(x, -13, -13, 26, 26, 6); x.fill();
    const pg = x.createLinearGradient(-14, 0, 14, 0); pg.addColorStop(0, "#8f949b"); pg.addColorStop(0.5, "#f2f3f5"); pg.addColorStop(1, "#9aa0a8");
    x.fillStyle = pg; rr(x, -11, 8, 22, 48, 9); x.fill();
    x.fillStyle = "#3a3d43"; rr(x, -5, 32, 10, 16, 4); x.fill();
    x.restore();
    return c;
  }

  function insideCanvas(back = false): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = L.px; c.height = L.py;
    const x = c.getContext("2d")!;
    x.fillStyle = leatherDark; x.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < c.height; i += 4) { x.fillStyle = "rgba(255,255,255,0.025)"; x.fillRect(0, i, c.width, 2); }
    grain(x, c.width, c.height, 6000, 0.05, false);
    if (back) {
      x.fillStyle = "rgba(255,255,255,0.45)"; x.textAlign = "center"; x.font = "400 54px 'Instrument Serif', Georgia, serif";
      x.fillText(`${pages} page${pages === 1 ? "" : "s"}`, c.width / 2, c.height / 2);
      return c;
    }
    // nameplate
    const nw = c.width * 0.66, nh = c.height * 0.44, nx = (c.width - nw) / 2, ny = c.height * 0.24;
    x.shadowColor = "rgba(0,0,0,0.45)"; x.shadowBlur = 30; x.shadowOffsetY = 12;
    const ng = x.createLinearGradient(nx, ny, nx + nw, ny + nh); ng.addColorStop(0, "#f6f2e8"); ng.addColorStop(1, "#e7ded0");
    x.fillStyle = ng; rr(x, nx, ny, nw, nh, 18); x.fill();
    x.shadowColor = "transparent";
    x.fillStyle = "#211d16"; x.textAlign = "center"; x.textBaseline = "alphabetic";
    x.font = `400 ${Math.round(nw * 0.12)}px 'Instrument Serif', Georgia, serif`;
    x.fillText(o.title, c.width / 2, ny + nh * 0.2, nw * 0.9);
    x.font = "500 22px Archivo, Helvetica, Arial, sans-serif"; x.fillStyle = "#6b5c3e";
    x.fillText(o.subtitle, c.width / 2, ny + nh * 0.29);
    if (o.progress) {
      const pct = o.progress.total ? o.progress.have / o.progress.total : 0;
      const cx = c.width / 2, cy = ny + nh * 0.55, r = nh * 0.17;
      x.lineWidth = 16; x.strokeStyle = "#d9cfb8"; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.stroke();
      x.strokeStyle = "#1d1d1d"; x.beginPath(); x.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2); x.stroke();
      x.fillStyle = "#211d16"; x.font = `400 ${Math.round(r * 0.8)}px 'Instrument Serif', Georgia, serif`; x.textBaseline = "middle";
      x.fillText(`${Math.round(pct * 100)}%`, cx, cy + 2);
      x.textBaseline = "alphabetic"; x.font = "500 22px Archivo, Helvetica, Arial, sans-serif"; x.fillStyle = "#4b4232";
      x.fillText(`${o.progress.have} of ${o.progress.total} cards`, cx, ny + nh * 0.86);
    }
    x.textAlign = "left"; x.font = "500 20px Archivo, Helvetica, Arial, sans-serif"; x.fillStyle = "#6b5c3e";
    const oy = ny + nh * 0.96;
    x.fillText("Property of", nx + 30, oy);
    x.strokeStyle = "#b3a37f"; x.setLineDash([6, 5]); x.lineWidth = 2; x.beginPath(); x.moveTo(nx + 150, oy + 4); x.lineTo(nx + nw - 30, oy + 4); x.stroke(); x.setLineDash([]);
    if (o.owner) { x.font = "500 40px Caveat, 'Bradley Hand', cursive"; x.fillStyle = "#1f2a5a"; x.fillText(o.owner, nx + 160, oy - 2); }
    x.fillStyle = "rgba(255,255,255,0.4)"; x.textAlign = "center"; x.font = "500 20px Archivo, Helvetica, Arial, sans-serif";
    x.fillText(`${pages} page${pages === 1 ? "" : "s"} · ${per}-pocket`, c.width / 2, c.height - 40);
    return c;
  }

  // face textures for leaf i: front = page 2i-1 (right side), back = page 2i (left side)
  const faces = new Map<string, WebGLTexture>();
  const blank = tex(insideCanvas(true));
  const coverInside = tex(insideCanvas());
  let coverZip = mem.open ? 1 : 0;
  let coverTex = tex(coverCanvas(coverZip));
  function faceTex(leaf: number, side: "front" | "back"): WebGLTexture {
    if (leaf < 0) return blank;
    if (leaf === 0) return side === "back" ? coverInside : coverTex;
    const pageNo = side === "front" ? 2 * leaf - 1 : 2 * leaf;
    if (pageNo > pages) return blank;
    const k = `${pageNo}`;
    if (!faces.has(k)) {
      let t: WebGLTexture;
      const cv = drawFace(pageNo, side, () => { if (faces.get(k) === t) { tex(cv, t); needsDraw = true; } });
      t = tex(cv);
      faces.set(k, t);
    }
    return faces.get(k)!;
  }
  function trimFaces(keepLeaves: number[]) {
    const keep = new Set(keepLeaves.flatMap((l) => [String(2 * l - 1), String(2 * l)]));
    for (const [k, t] of faces) if (!keep.has(k)) { gl!.deleteTexture(t); faces.delete(k); }
  }

  // ---------------------------------------------------------------- state
  // f = number of leaves lying on the left (0 = closed, 1 = cover open)
  let f = mem.open ? Math.max(1, Math.min(leafCount, mem.f)) : 0;
  type Turn = { leaf: number; theta: number; from: number; to: number; t0: number; dur: number; drag?: boolean; c: number; done?: () => void };
  let turns: Turn[] = [];
  let zipping: { from: number; to: number; t0: number; dur: number; done: () => void } | null = null;
  let needsDraw = true;
  let camT = mem.open ? 1 : 0; // 0 = closed framing, 1 = open spread
  let camGoal = camT;
  let mx = 0, my = 0;

  const twoUp = () => canvas.clientWidth >= 720;
  // On narrow screens one page fills the view: read the left page, slide across to the
  // right page, then turn. side = which page of the open spread is in view.
  let side: "left" | "right" = "right";
  let pan = 0.5, panGoal = 0.5, lastPan = 0; // camera centre in page widths (-0.5 left page, 0.5 right page)
  const setSide = (s2: "left" | "right") => { side = s2; panGoal = s2 === "left" ? -0.5 : 0.5; needsDraw = true; renderBar(); };
  function forward() {
    if (!twoUp() && f >= 2 && side === "left") { setSide("right"); swish(1.6); return; }
    const before = f;
    next();
    if (!twoUp() && f > before && f >= 2) setSide("left");
  }
  function back() {
    if (!twoUp() && f >= 2 && side === "right") { setSide("left"); swish(1.6); return; }
    const before = f;
    prev();
    if (!twoUp() && f < before) setSide("right");
  }
  const sheetThick = 0.0045;
  const yRight = (count: number) => 0.016 + count * sheetThick;
  const leftCount = () => Math.max(0, f - 1);
  const rightCount = () => leafCount - f;

  function startTurn(leaf: number, dir: 1 | -1, dur = 720, drag = false, theta?: number) {
    const from = theta ?? (dir > 0 ? 0 : Math.PI), to = dir > 0 ? Math.PI : 0;
    turns.push({ leaf, theta: from, from, to, t0: performance.now(), dur, drag, c: 0 });
    needsDraw = true;
  }

  function settle(t: Turn) {
    t.drag = false; t.from = t.theta; t.t0 = performance.now();
    t.dur = 520 * Math.max(0.35, Math.abs(t.to - t.from) / Math.PI);
  }

  function next(n = 1) {
    if (zipping) return;
    if (f === 0) { open(); return; }
    let q = 0;
    for (let i = 0; i < n && f < leafCount; i++) {
      const leaf = f; f++;
      const delay = i * 85;
      setTimeout(() => { startTurn(leaf, 1, n > 1 ? 480 : 720); swish(n > 1 ? 1.8 : 1); }, delay);
      q++;
    }
    if (q) save();
  }
  function prev(n = 1) {
    if (zipping || f <= 1) return;
    for (let i = 0; i < n && f > 1; i++) {
      f--; const leaf = f;
      setTimeout(() => { startTurn(leaf, -1, n > 1 ? 480 : 720); swish(n > 1 ? 1.8 : 1); }, i * 85);
    }
    save();
  }
  function goToPage(page: number) {
    const leaf = Math.max(1, Math.min(leafCount, Math.ceil(page / 2) + (page % 2 === 1 ? 0 : 1)));
    const target = page <= 1 ? 1 : Math.min(leafCount, Math.floor(page / 2) + 1);
    void leaf;
    if (target > f) next(target - f); else if (target < f) prev(f - target);
    if (!twoUp()) setSide(page % 2 === 0 && target >= 2 ? "left" : "right");
  }
  function open() {
    if (f > 0 || zipping) return;
    zipSound(1.1);
    zipping = { from: coverZip, to: 1, t0: performance.now(), dur: 1100, done: () => {
      f = 1; camGoal = 1; startTurn(0, 1, 1000); setTimeout(() => thud(0.7), 900); save();
    } };
  }
  function close() {
    if (f === 0 || zipping) return;
    const n = f - 1;
    for (let i = 0; i < n; i++) { const leaf = f - 1 - i; setTimeout(() => { startTurn(leaf, -1, 380); if (i % 2 === 0) swish(2); }, i * 60); }
    const coverDelay = n * 60 + 250;
    f = 0;
    setTimeout(() => { startTurn(0, -1, 900); camGoal = 0; }, coverDelay);
    setTimeout(() => { thud(0.8); zipSound(1.0); zipping = { from: 1, to: 0, t0: performance.now(), dur: 1000, done: () => {} }; }, coverDelay + 950);
    save();
  }
  function save() { mem.open = f > 0; mem.f = f; renderBar(); }

  // ---------------------------------------------------------------- camera + picking
  let vp: Mat4 = new Float32Array(16), cam = [0, 2, 2];
  function camera(aspect: number) {
    const fov = 0.62, tn = Math.tan(fov / 2);
    const tilt = 0.98; // radians from horizontal
    const spanOpen = twoUp() ? L.W * 2 + 0.25 : L.W * 1.08;
    const spanClosed = COVER_W * 1.18;
    const fit = (span: number, cx: number) => {
      const dW = span / (2 * tn * aspect), dH = (L.H * 1.12 * Math.sin(tilt) + 0.06) / (2 * tn);
      return { d: Math.max(dW, dH) * 1.2, cx };
    };
    const a = fit(spanClosed, COVER_W / 2), b = fit(spanOpen, twoUp() ? 0 : pan * L.W);
    const k = easeInOut(camT);
    const d = lerp(a.d, b.d, k), cx = lerp(a.cx, b.cx, k);
    cam = [cx + mx * 0.05, d * Math.sin(tilt), d * Math.cos(tilt) + 0.02 - my * 0.03];
    vp = multiply(perspective(fov, aspect, 0.05, 30), lookAt(cam, [cx, 0, 0.03]));
  }
  function pick(clientX: number, clientY: number): { side: "left" | "right"; u: number; v: number; x: number } | null {
    const b = canvas.getBoundingClientRect();
    const inv = invert(vp); if (!inv) return null;
    const { o: ro, d } = rayFrom(inv, clientX - b.left, clientY - b.top, b.width, b.height);
    const yPlane = yRight(rightCount());
    if (Math.abs(d[1]) < 1e-5) return null;
    const t = (yPlane - ro[1]) / d[1];
    const x = ro[0] + d[0] * t, z = ro[2] + d[2] * t;
    const v = z / L.H + 0.5;
    if (v < 0 || v > 1) return { side: x >= 0 ? "right" : "left", u: Math.abs(x) / L.W, v, x };
    return { side: x >= 0 ? "right" : "left", u: Math.abs(x) / L.W, v, x };
  }
  function pocketAt(p: { side: "left" | "right"; u: number; v: number }): number | null {
    if (p.u > 1 || p.v < 0 || p.v > 1) return null;
    const cx = p.side === "right" ? p.u : 1 - p.u;
    const idx = L.pockets.findIndex((q) => cx >= q.x && cx <= q.x + q.w && p.v >= q.y && p.v <= q.y + q.h);
    if (idx < 0) return null;
    const pageNo = p.side === "right" ? 2 * f - 1 : 2 * (f - 1);
    if (pageNo < 1 || pageNo > pages) return null;
    const item = (pageNo - 1) * per + idx;
    return item < o.items.length ? item : null;
  }

  // ---------------------------------------------------------------- input
  let down: { x: number; y: number; t: number; leaf?: number; dir?: 1 | -1; turn?: Turn; lastTheta?: number; lastT?: number; vel?: number } | null = null;
  canvas.addEventListener("pointermove", (e) => {
    const b = canvas.getBoundingClientRect();
    mx = ((e.clientX - b.left) / b.width) * 2 - 1; my = ((e.clientY - b.top) / b.height) * 2 - 1;
    needsDraw = true;
    if (!down) {
      if (f > 0 && !turns.length) { const p = pick(e.clientX, e.clientY); canvas.style.cursor = p && pocketAt(p) != null ? "pointer" : p && p.u <= 1.05 && p.v >= 0 && p.v <= 1 ? "grab" : "default"; }
      else canvas.style.cursor = f === 0 ? "pointer" : "default";
      return;
    }
    if (f === 0 || zipping) return;
    const dx = e.clientX - down.x;
    if (!down.turn) {
      if (Math.abs(dx) < 10) return;
      const p = pick(down.x, down.y);
      if (!p) return;
      if (p.side === "right" && dx < 0 && f < leafCount) { down.leaf = f; down.dir = 1; f++; }
      else if (p.side === "left" && dx > 0 && f > 1) { f--; down.leaf = f; down.dir = -1; }
      else return;
      const t: Turn = { leaf: down.leaf, theta: down.dir > 0 ? 0 : Math.PI, from: 0, to: down.dir > 0 ? Math.PI : 0, t0: 0, dur: 1, drag: true, c: 0 };
      turns.push(t); down.turn = t; swish(0.9);
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = "grabbing";
    }
    const p = pick(e.clientX, e.clientY);
    if (!p || !down.turn) return;
    const xr = Math.max(-L.W, Math.min(L.W, p.x));
    const th = Math.acos(xr / L.W);
    const now = performance.now();
    if (down.lastTheta != null) down.vel = (th - down.lastTheta) / Math.max(1, now - down.lastT!) * 1000;
    down.lastTheta = th; down.lastT = now;
    down.turn.theta = th;
    down.turn.c = 0.45 * Math.sin(th) * (down.dir! > 0 ? 1 : -1);
    needsDraw = true;
  });
  canvas.addEventListener("pointerdown", (e) => { canvas.focus({ preventScroll: true }); down = { x: e.clientX, y: e.clientY, t: performance.now() }; audio(); });
  const up = (e: PointerEvent) => {
    if (!down) return;
    const d = down; down = null;
    if (d.turn) {
      const t = d.turn, vel = d.vel ?? 0;
      const forward = d.dir! > 0;
      const complete = forward ? t.theta > Math.PI / 2 || vel > 3.5 : t.theta < Math.PI / 2 || vel < -3.5;
      if (complete) { t.to = forward ? Math.PI : 0; }
      else { t.to = forward ? 0 : Math.PI; f += forward ? -1 : 1; }
      settle(t); save();
      if (!twoUp() && complete) setSide(forward ? "left" : "right");
      canvas.style.cursor = "grab";
      return;
    }
    // on a phone, a sideways swipe slides between the two pages of a spread (or turns)
    const sx = e.clientX - d.x;
    if (!twoUp() && f > 0 && Math.abs(sx) > 40 && Math.abs(sx) > Math.abs(e.clientY - d.y)) { if (sx < 0) forward(); else back(); return; }
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) return;
    if (f === 0) { open(); return; }
    const p = pick(e.clientX, e.clientY);
    if (!p) return;
    const idx = pocketAt(p);
    if (idx != null) { const it = o.items[idx]; if (it.kind === "add") o.onAdd?.(); else o.onCard(idx); return; }
    if (p.v >= 0 && p.v <= 1 && p.u <= 1.05) {
      if (twoUp()) { if (p.side === "right") next(); else prev(); }
      else if (p.x >= pan * L.W) forward(); else back();
    }
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("pointerleave", () => { mx = 0; my = 0; needsDraw = true; });
  canvas.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); forward(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
    else if ((e.key === "Enter" || e.key === " ") && f === 0) { e.preventDefault(); open(); }
  });

  // ---------------------------------------------------------------- bar
  function renderBar() {
    const one = !twoUp(), here = one && f >= 2 && side === "left" ? 2 * (f - 1) : 2 * f - 1;
    const label = f === 0 ? "Zipped" : f === 1 ? (one ? "Page 1" : "Inside cover · page 1")
      : one ? `Page ${Math.min(pages, here)} of ${pages}` : `Pages ${2 * (f - 1)}${2 * f - 1 <= pages ? `–${2 * f - 1}` : ""} of ${pages}`;
    bar.replaceChildren(
      btn("‹", "Previous page", () => back(), f <= 1 && (!one || side === "right")),
      el("span", "b3-label", label),
      btn("›", "Next page", () => forward(), f === 0 || (f >= leafCount && (!one || side === "right") ) || (one && here >= pages)),
      o.jumps?.length ? (() => {
        const s = document.createElement("select");
        s.className = "b3-jump"; s.setAttribute("aria-label", "Jump to a section");
        s.append(new Option("Jump to…", ""), ...o.jumps.map((j) => new Option(`${j.label} · page ${j.page}`, String(j.page))));
        s.onchange = () => { if (s.value) { if (f === 0) open(); setTimeout(() => goToPage(Number(s.value)), f === 0 ? 2200 : 0); s.value = ""; } };
        return s;
      })() : el("span", "", ""),
      btn(soundOn() ? "Sound on" : "Sound off", "Page sounds", () => { setSound(!soundOn()); renderBar(); }, false, "b3-sound"),
      f === 0 ? btn("Unzip", "Unzip the binder", () => open(), false, "b3-primary") : btn("Zip it up", "Close the binder", () => close(), false, "b3-primary"));
  }
  function btn(text: string, label: string, on: () => void, disabled = false, cls = "") {
    const b = document.createElement("button");
    b.type = "button"; b.className = `b3-btn ${cls}`; b.textContent = text; b.setAttribute("aria-label", label); b.disabled = disabled; b.onclick = on;
    return b;
  }
  function el(tag: string, cls: string, text: string) { const e = document.createElement(tag); e.className = cls; e.textContent = text; return e; }
  renderBar();

  // ---------------------------------------------------------------- draw loop
  const light = [-0.45, 1.0, 0.6];
  function drawBox(x0: number, y0: number, z0: number, sx: number, sy: number, sz: number, color: number[], sheen = 0.05) {
    gl!.useProgram(boxP);
    gl!.bindVertexArray(boxVao);
    gl!.uniformMatrix4fv(bu.uVP, false, vp);
    gl!.uniformMatrix4fv(bu.uModel, false, compose([x0, y0, z0], [0, 0, 0], [sx, sy, sz]));
    gl!.uniform3fv(bu.uColor, color); gl!.uniform3fv(bu.uLight, light); gl!.uniform3fv(bu.uCam, cam); gl!.uniform1f(bu.uSheen, sheen);
    gl!.drawArrays(gl!.TRIANGLES, 0, 36);
  }
  function drawLeaf(leaf: number, theta: number, c: number, y: number, shadow = 0, ext = 0) {
    const isCover = leaf === 0;
    gl!.useProgram(sheetP);
    gl!.bindVertexArray(sheetVao);
    gl!.uniformMatrix4fv(su.uVP, false, vp);
    gl!.uniformMatrix4fv(su.uModel, false, compose(isCover ? [0, 0, 0] : [0.012, 0, 0], [0, 0, 0], 1));
    gl!.uniform1f(su.uTheta, theta); gl!.uniform1f(su.uC, c);
    gl!.uniform1f(su.uW, isCover ? COVER_W : L.W); gl!.uniform1f(su.uH, isCover ? COVER_H : L.H); gl!.uniform1f(su.uY, y);
    gl!.uniform3fv(su.uCam, cam); gl!.uniform3fv(su.uLight, light);
    gl!.uniform1f(su.uGloss, isCover ? 0.18 : 1); gl!.uniform1f(su.uLeather, isCover ? 1 : 0);
    gl!.uniform1f(su.uShadow, shadow); gl!.uniform1f(su.uShadowExt, ext);
    gl!.activeTexture(gl!.TEXTURE0); gl!.bindTexture(gl!.TEXTURE_2D, faceTex(leaf, "front")); gl!.uniform1i(su.uFront, 0);
    gl!.activeTexture(gl!.TEXTURE1); gl!.bindTexture(gl!.TEXTURE_2D, faceTex(leaf, "back")); gl!.uniform1i(su.uBack, 1);
    gl!.drawArrays(gl!.TRIANGLES, 0, SEG * 6);
  }

  const rgb = (css: string) => { const m = css.match(/\d+/g)!.map(Number); return [m[0] / 255, m[1] / 255, m[2] / 255]; };
  const leatherRGB = rgb(leather), darkRGB = rgb(leatherDark);
  let raf = 0, stopped = false;
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    // advance animations
    for (const t of turns) {
      if (t.drag) continue;
      const k = clamp01((now - t.t0) / t.dur), e = easeInOut(k);
      t.theta = lerp(t.from, t.to, e);
      // stiff sleeve: the free edge lags as it swings, then catches up
      t.c = (t.leaf === 0 ? 0.04 : -0.55) * Math.sin(t.theta) * (t.to > t.from ? 1 : -1) * (1 - Math.abs(2 * k - 1) * 0.35);
      if (k >= 1) { t.done?.(); (t as Turn & { finished?: boolean }).finished = true; if (t.leaf !== 0) thud(0.5); }
      needsDraw = true;
    }
    turns = turns.filter((t) => !(t as Turn & { finished?: boolean }).finished);
    if (zipping) {
      const k = clamp01((now - zipping.t0) / zipping.dur);
      coverZip = lerp(zipping.from, zipping.to, easeInOut(k));
      tex(coverCanvas(coverZip), coverTex);
      if (k >= 1) { const d = zipping.done; zipping = null; d(); }
      needsDraw = true;
    }
    if (Math.abs(camT - camGoal) > 1e-3) { camT = lerp(camT, camGoal, 0.06); needsDraw = true; }
    const dtp = Math.min(0.1, (now - (lastPan || now)) / 1000); lastPan = now;
    if (Math.abs(pan - panGoal) > 1e-3) { pan = lerp(pan, panGoal, 1 - Math.exp(-dtp * 9)); needsDraw = true; } else pan = panGoal;
    if (!needsDraw) return;
    needsDraw = false;
    // size
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl!.viewport(0, 0, w, h);
    gl!.clearColor(0, 0, 0, 0);
    gl!.clear(gl!.COLOR_BUFFER_BIT | gl!.DEPTH_BUFFER_BIT);
    camera(w / Math.max(1, h));

    const turning = new Set(turns.map((t) => t.leaf));
    // which leaves rest on each side (ignoring ones in flight)
    const leftTop = (() => { for (let i = f - 1; i >= 0; i--) if (!turning.has(i)) return i; return -1; })();
    const rightTop = (() => { for (let i = f; i < leafCount; i++) if (!turning.has(i)) return i; return -1; })();
    const nRight = leafCount - Math.max(f, 0), nLeft = Math.max(0, f - 1);
    // back cover + spine
    const bw = COVER_W, bh = COVER_H;
    drawBox(0, -0.014, -bh / 2, bw, 0.014, bh, leatherRGB, 0.06);
    if (f > 0 || turning.has(0)) drawBox(-bw, -0.014, -bh / 2, bw, 0.014, bh, leatherRGB, 0.06);
    drawBox(-0.03, -0.016, -bh / 2, 0.06, 0.022, bh, darkRGB, 0.08);
    // page blocks (the sleeves underneath)
    if (nRight > 1) drawBox(0.014, 0, -L.H / 2, L.W, yRight(nRight - 1) - 0.002, L.H, [0.09, 0.09, 0.1], 0.12);
    if (nLeft > 1) drawBox(-L.W - 0.014, 0, -L.H / 2, L.W, yRight(nLeft - 1) - 0.002, L.H, [0.09, 0.09, 0.1], 0.12);
    // shadows cast by the leaf in flight
    let shR = 0, extR = 0, shL = 0, extL = 0;
    for (const t of turns) {
      const th = t.theta;
      if (th < Math.PI / 2) { shR = Math.max(shR, 0.55 * clamp01(th / 0.35)); extR = Math.max(extR, Math.cos(th) * 1.05); }
      else { shL = Math.max(shL, 0.55 * clamp01((Math.PI - th) / 0.35)); extL = Math.max(extL, -Math.cos(th) * 1.05); }
    }
    // resting leaves
    if (rightTop >= 0) drawLeaf(rightTop, 0, 0, rightTop === 0 ? 0.004 + yRight(nRight - 1) : yRight(Math.max(0, nRight - 1)), shR, extR);
    else if (f > 0) drawLeaf(-1 as unknown as number, 0, 0, 0.002, shR, extR);
    if (leftTop >= 0) drawLeaf(leftTop, Math.PI, 0, leftTop === 0 ? 0.002 : yRight(Math.max(0, nLeft - 1)), shL, extL);
    // leaves in flight
    for (const t of turns) drawLeaf(t.leaf, t.theta, t.c, 0.012 + yRight(Math.max(nLeft, nRight)));
    // keep textures for nearby leaves only
    trimFaces([leftTop, rightTop, ...turning, f - 1, f, f + 1].filter((x) => x > 0));
    if (turns.length || zipping) needsDraw = true;
  }

  const ro = new ResizeObserver(() => { needsDraw = true; renderBar(); });
  requestAnimationFrame(() => { ro.observe(canvas); raf = requestAnimationFrame(frame); });
  const stop = () => {
    if (stopped) return; stopped = true;
    cancelAnimationFrame(raf); ro.disconnect();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    live.delete(stop);
  };
  live.add(stop);
  return wrap;
}

function rr(x: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, r: number) {
  x.beginPath(); x.roundRect(X, Y, W, H, r);
}
