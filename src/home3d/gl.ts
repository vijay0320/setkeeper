// A small WebGL2 renderer for trading cards: a thin rounded box with the card art on the
// front, SetKeeper's own back design, a pale edge, soft studio lighting and a holo foil
// layer whose colour shifts with the viewing angle.
import { type Mat4 } from "./math.ts";

export const CARD_W = 0.63, CARD_H = 0.88, CARD_D = 0.012;

const VS = `#version 300 es
in vec3 aPos; in vec3 aNormal; in vec2 aUv; in float aFace;
uniform mat4 uModel, uViewProj;
out vec3 vPos; out vec3 vNormal; out vec2 vUv; flat out int vFace;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vPos = w.xyz; vNormal = normalize(mat3(uModel) * aNormal); vUv = aUv; vFace = int(aFace);
  gl_Position = uViewProj * w;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vNormal; in vec2 vUv; flat in int vFace;
uniform sampler2D uFront, uBack;
uniform vec4 uRect;          // sub-rectangle of uFront (atlas)
uniform vec3 uCam, uLight;
uniform float uFoil, uGhost, uAlpha, uTime, uScan;
out vec4 frag;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  // rounded corners
  if (vFace < 2) {
    vec2 q = vec2(vUv.x * ${CARD_W.toFixed(3)}, vUv.y * ${CARD_H.toFixed(3)});
    vec2 c = clamp(q, vec2(0.032), vec2(${(CARD_W - 0.032).toFixed(3)}, ${(CARD_H - 0.032).toFixed(3)}));
    if (distance(q, c) > 0.032) discard;
  }
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCam - vPos);
  if (dot(N, V) < 0.0 && vFace == 2) N = -N;
  vec3 base;
  if (vFace == 0) base = texture(uFront, uRect.xy + vUv * uRect.zw).rgb;
  else if (vFace == 1) base = texture(uBack, vec2(1.0 - vUv.x, vUv.y)).rgb;
  else base = vec3(0.86, 0.85, 0.82);
  vec3 L = normalize(uLight - vPos);
  vec3 H = normalize(L + V);
  float diff = 0.72 + 0.38 * max(dot(N, L), 0.0);
  float spec = pow(max(dot(N, H), 0.0), 70.0);
  vec3 col = base * diff;
  if (vFace == 0 && uFoil > 0.0) {
    vec3 R = reflect(-V, N);
    float t = vUv.x * 1.3 + vUv.y * 0.9 + dot(R, vec3(0.7, 0.45, 0.25)) * 2.2 + uTime * 0.03;
    vec3 irid = 0.55 + 0.45 * cos(6.2831 * (t + vec3(0.0, 0.33, 0.67)));
    float lum = dot(base, vec3(0.299, 0.587, 0.114));
    float mask = smoothstep(0.08, 0.5, lum) * (1.0 - smoothstep(0.85, 1.0, lum) * 0.6);
    col = mix(col, col * irid * 1.55, uFoil * 0.42 * mask);
    float sparkle = step(0.985, hash(floor(vUv * vec2(160.0, 220.0)))) * pow(max(dot(N, H), 0.0), 12.0);
    col += sparkle * uFoil * 0.9 * irid;
  }
  col += spec * (vFace == 0 ? 0.35 + 0.35 * uFoil : 0.25);
  if (uGhost > 0.0) {
    float g = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(g) * 0.55 + 0.2, uGhost);
  }
  // scanning beam: a bright band sweeping down the card face
  if (vFace == 0 && uScan > 0.0) {
    float d = abs(vUv.y - uScan);
    col += vec3(0.25, 0.65, 1.0) * smoothstep(0.035, 0.0, d) * 1.2;
    col = mix(col, col * vec3(0.85, 0.95, 1.1), step(vUv.y, uScan) * 0.35);
  }
  frag = vec4(col, uAlpha * (1.0 - uGhost * 0.45));
}`;

export interface CardDraw {
  model: Mat4;
  tex: WebGLTexture;
  rect?: [number, number, number, number];
  foil?: number;
  ghost?: number;
  alpha?: number;
  scan?: number;
}

export class Renderer {
  gl: WebGL2RenderingContext;
  prog: WebGLProgram;
  vao: WebGLVertexArrayObject;
  count: number;
  back: WebGLTexture;
  u: Record<string, WebGLUniformLocation | null> = {};
  canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: false });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    this.prog = program(gl, VS, FS);
    for (const n of ["uModel", "uViewProj", "uFront", "uBack", "uRect", "uCam", "uLight", "uFoil", "uGhost", "uAlpha", "uTime", "uScan"]) this.u[n] = gl.getUniformLocation(this.prog, n);
    const { vao, count } = cardGeometry(gl, this.prog);
    this.vao = vao; this.count = count;
    this.back = this.textureFromCanvas(cardBack());
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.gl.viewport(0, 0, w, h);
    return w / Math.max(1, h);
  }

  begin(viewProj: Mat4, cam: number[], light: number[], time: number) {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(this.u.uViewProj, false, viewProj);
    gl.uniform3fv(this.u.uCam, cam);
    gl.uniform3fv(this.u.uLight, light);
    gl.uniform1f(this.u.uTime, time);
    gl.uniform1i(this.u.uFront, 0);
    gl.uniform1i(this.u.uBack, 1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.back);
  }

  draw(d: CardDraw) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, d.tex);
    gl.uniformMatrix4fv(this.u.uModel, false, d.model);
    gl.uniform4fv(this.u.uRect, d.rect ?? [0, 0, 1, 1]);
    gl.uniform1f(this.u.uFoil, d.foil ?? 0);
    gl.uniform1f(this.u.uGhost, d.ghost ?? 0);
    gl.uniform1f(this.u.uAlpha, d.alpha ?? 1);
    gl.uniform1f(this.u.uScan, d.scan ?? 0);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
  }

  textureFromCanvas(src: TexImageSource): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const ext = gl.getExtension("EXT_texture_filter_anisotropic");
    if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    return t;
  }

  destroy() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "aPos");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link error");
  return p;
}

/** Card-shaped box centred on the origin: front faces +z. */
function cardGeometry(gl: WebGL2RenderingContext, prog: WebGLProgram) {
  const w = CARD_W / 2, h = CARD_H / 2, d = CARD_D / 2;
  const v: number[] = [];
  const quad = (a: number[], b: number[], c: number[], e: number[], n: number[], uv: number[][], face: number) => {
    for (const [p, t] of [[a, uv[0]], [b, uv[1]], [c, uv[2]], [a, uv[0]], [c, uv[2]], [e, uv[3]]] as [number[], number[]][]) v.push(...p, ...n, ...t, face);
  };
  const UV = [[0, 0], [1, 0], [1, 1], [0, 1]];
  quad([-w, -h, d], [w, -h, d], [w, h, d], [-w, h, d], [0, 0, 1], UV, 0);
  quad([w, -h, -d], [-w, -h, -d], [-w, h, -d], [w, h, -d], [0, 0, -1], [[1, 0], [0, 0], [0, 1], [1, 1]], 1);
  const r = 0.03; // shrink edges a little so the rounded corners hide them
  quad([w, -h + r, d], [w, -h + r, -d], [w, h - r, -d], [w, h - r, d], [1, 0, 0], UV, 2);
  quad([-w, -h + r, -d], [-w, -h + r, d], [-w, h - r, d], [-w, h - r, -d], [-1, 0, 0], UV, 2);
  quad([-w + r, h, d], [w - r, h, d], [w - r, h, -d], [-w + r, h, -d], [0, 1, 0], UV, 2);
  quad([-w + r, -h, -d], [w - r, -h, -d], [w - r, -h, d], [-w + r, -h, d], [0, -1, 0], UV, 2);
  const buf = gl.createBuffer();
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
  const stride = 9 * 4;
  const attr = (name: string, size: number, off: number) => {
    const loc = gl.getAttribLocation(prog, name);
    if (loc < 0) return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
  };
  attr("aPos", 3, 0); attr("aNormal", 3, 3); attr("aUv", 2, 6); attr("aFace", 1, 8);
  return { vao, count: v.length / 9 };
}

/** SetKeeper's own card back: navy leather, gold stitching, a monogram seal. */
export function cardBack(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 504; c.height = 704;
  const x = c.getContext("2d")!;
  const g = x.createLinearGradient(0, 0, 504, 704);
  g.addColorStop(0, "#27477a"); g.addColorStop(1, "#122440");
  x.fillStyle = g; x.fillRect(0, 0, 504, 704);
  for (let i = 0; i < 9000; i++) { x.fillStyle = `rgba(255,255,255,${Math.random() * 0.035})`; x.fillRect(Math.random() * 504, Math.random() * 704, 1.5, 1.5); }
  x.strokeStyle = "#e2ad48"; x.lineWidth = 4; x.setLineDash([14, 10]);
  x.strokeRect(34, 34, 436, 636);
  x.setLineDash([]);
  x.beginPath(); x.arc(252, 352, 96, 0, Math.PI * 2); x.fillStyle = "rgba(226,173,72,0.12)"; x.fill();
  x.lineWidth = 5; x.strokeStyle = "#e2ad48"; x.stroke();
  x.fillStyle = "#f3e6c8"; x.font = "800 86px Archivo, Helvetica, Arial, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
  x.fillText("SK", 252, 356);
  x.font = "600 26px Archivo, Helvetica, Arial, sans-serif"; x.fillStyle = "rgba(243,230,200,0.75)";
  x.fillText("SetKeeper", 252, 500);
  return c;
}

/** Card image → texture; falls back to a lettered placeholder if the image can't load. */
/** Load a card image. `url` may list fallbacks separated by spaces: each is tried in turn. */
export function loadCardImage(url: string, label: string): Promise<HTMLImageElement | HTMLCanvasElement> {
  const urls = url.split(" ").filter(Boolean);
  return new Promise((resolve) => {
    const tryNext = () => {
      const u = urls.shift();
      if (!u) return resolve(placeholder(label));
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = tryNext;
      img.src = u;
    };
    tryNext();
  });
}

export function placeholder(label: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 252; c.height = 352;
  const x = c.getContext("2d")!;
  x.fillStyle = "#d9d3c7"; x.fillRect(0, 0, 252, 352);
  x.strokeStyle = "#9a9283"; x.lineWidth = 3; x.setLineDash([8, 6]); x.strokeRect(14, 14, 224, 324);
  x.fillStyle = "#5f5a52"; x.font = "600 22px Archivo, Helvetica, Arial, sans-serif"; x.textAlign = "center";
  const words = label.split(" ");
  words.forEach((w, i) => x.fillText(w, 126, 160 + i * 28));
  return c;
}

/** Pack many card images into one texture for the set wall. */
export function atlas(images: (HTMLImageElement | HTMLCanvasElement)[], cols: number) {
  const cw = 100, ch = 140, rows = Math.ceil(images.length / cols);
  const c = document.createElement("canvas");
  c.width = cols * cw; c.height = rows * ch;
  const x = c.getContext("2d")!;
  images.forEach((im, i) => x.drawImage(im, (i % cols) * cw, Math.floor(i / cols) * ch, cw, ch));
  const rects = images.map((_, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    // texture is flipped on upload, so rows count up from the bottom
    return [col / cols, 1 - (row + 1) / rows, 1 / cols, 1 / rows] as [number, number, number, number];
  });
  return { canvas: c, rects };
}
