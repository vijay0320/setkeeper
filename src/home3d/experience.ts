// The SetKeeper home: a scroll-driven film in WebGL.
//   1. A single holo card hangs in the light; it follows your pointer.
//   2. Your chase list drifts past, tilted in 3D, with each card's details beside it.
//   3. Nine cards fly into the pockets of a binder page.
//   4. A scan beam reads a card; it's matched and filed.
//   5. Centering guides lock onto a card's edges.
//   6. The whole set assembles into a wall: owned cards in colour, missing ones ghosted.
import { Renderer, CARD_W, CARD_H, loadCardImage, atlas, placeholder } from "./gl.ts";
import { compose, lookAt, multiply, perspective, lerp, range, easeInOut, easeOut, clamp01 } from "./math.ts";

export interface FilmCard {
  id: string;
  name: string;
  number: string;
  rarity: string;
  owned: boolean;
  status: string;
  priority: string;
  price?: string; // formatted CAD
  tex: string; // CORS-safe image URL for WebGL
  thumb: string; // smaller image for the wall
  foil: number; // 0..1
}

export interface FilmData {
  setName: string;
  owned: number;
  total: number;
  hero: FilmCard;
  chase: FilmCard[];
  page: FilmCard[];
  scan: FilmCard;
  wall: FilmCard[];
  links: { binder: string; shelf: string; scan: string; buy: string; packs: string; grade: string };
}

type El = HTMLElement;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", html = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function mountFilm(root: El, data: FilmData): () => void {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  root.classList.add("film");
  root.innerHTML = "";

  // ---------- DOM ----------
  const track = el("div", "film-track");
  const stage = el("div", "film-stage");
  const canvas = el("canvas", "film-canvas") as HTMLCanvasElement;
  const overlay = el("div", "film-overlay");
  stage.append(canvas, overlay);
  track.append(stage);

  const bar = el("header", "film-bar",
    `<a class="fb-word" href="#home">SetKeeper</a>
     <nav class="fb-nav" aria-label="Sections"><a href="${data.links.binder}">Binder</a><a href="${data.links.scan}">Scan</a><a href="${data.links.buy}">Buy</a><a href="${data.links.packs}">Packs</a><a href="${data.links.grade}">Grade</a></nav>
     <a class="fb-open" href="${data.links.binder}">Open the app</a>`);

  const loader = el("div", "film-loader", `<span class="fl-count">0</span><span class="fl-label">Laying out ${esc(data.setName)}</span>`);
  const count = loader.querySelector(".fl-count") as El;

  const chapter = (cls: string, html: string) => { const c = el("section", `fc ${cls}`, html); overlay.append(c); return c; };
  const hero = chapter("fc-hero", `
    <p class="fc-kicker">${esc(data.setName)} · ${data.owned} of ${data.total}</p>
    <h1 class="fc-title">Every card<br>in its place.</h1>
    <p class="fc-sub">A binder for every set you collect. Scan cards, see fair prices, plan what to buy and check centering before you grade.</p>
    <p class="fc-scroll">Scroll</p>`);
  const meta = chapter("fc-meta", "");
  const quotes = chapter("fc-quotes", "");
  const chaseTitle = chapter("fc-side fc-chase", `<h2>Your chase list.</h2><p>The cards you still need, highest priority first, with what they cost and where.</p><a href="${data.links.buy}">Plan the cheapest cart</a>`);
  const binderTitle = chapter("fc-side fc-binder", `<h2>One binder<br>for every set.</h2><p>Nine pockets a page, real page turns, a zip that opens. Missing cards wait as ghosts in their pockets.</p><a href="${data.links.binder}">Open your binder</a>`);
  const scanTitle = chapter("fc-side fc-scan right", `<h2>Point.<br>Scan. Filed.</h2><p>Your phone matches the card against every official image in the set, on the device. 98.4% right on the first guess in testing.</p><a href="${data.links.scan}">Scan a card</a>`);
  const scanTag = chapter("fc-tag", `<b>${esc(data.scan.name)}</b> ${esc(data.scan.number)}<span>Matched</span>`);
  const gradeTitle = chapter("fc-side fc-grade", `<h2>Centering,<br>measured.</h2><p>Guides find the edge and the inner frame. You see the ratios, the best grade they allow, and whether grading is worth the fees.</p><a href="${data.links.grade}">Check a card</a>`);
  const guides = chapter("fc-guides", `<i class="g ol"></i><i class="g or"></i><i class="g il"></i><i class="g ir"></i><span class="g-read">52 / 48<small>left to right</small></span>`);
  const wallTitle = chapter("fc-wall", `<h2>${data.owned} of ${data.total}.</h2><p>Your ${esc(data.setName)} so far. Every set from Base Set to today gets a binder of its own.</p>
    <div class="fc-cta"><a class="fc-btn" href="${data.links.binder}">Open your binder</a><a href="${data.links.shelf}">Add a set</a></div>`);

  root.append(bar, track, loader);

  // ---------- GL ----------
  let r: Renderer;
  try { r = new Renderer(canvas); } catch {
    root.classList.add("film-fallback");
    loader.remove();
    return () => {};
  }
  const tex = new Map<string, WebGLTexture>();
  const uniq = new Map<string, FilmCard>();
  for (const c of [data.hero, ...data.chase, ...data.page, data.scan]) uniq.set(c.id, c);
  let loaded = 0;
  const total = uniq.size + 1;
  const bump = () => { loaded++; count.textContent = String(Math.round((100 * loaded) / total)); };
  const ready = Promise.all([...uniq.values()].map(async (c) => { tex.set(c.id, r.textureFromCanvas(await loadCardImage(c.tex, c.name))); bump(); }));
  let wallTex: WebGLTexture | null = null;
  let wallRects: [number, number, number, number][] = [];
  const cols = Math.min(20, Math.max(8, Math.ceil(Math.sqrt(data.wall.length * 1.6))));
  const wallReady = Promise.all(data.wall.map((c) => loadCardImage(c.thumb, c.name))).then((imgs) => {
    const a = atlas(imgs, cols);
    wallTex = r.textureFromCanvas(a.canvas);
    wallRects = a.rects;
    bump();
  });
  // pocket page texture
  const pageCanvas = document.createElement("canvas");
  pageCanvas.width = 640; pageCanvas.height = 880;
  {
    const x = pageCanvas.getContext("2d")!;
    x.fillStyle = "#14171c"; x.fillRect(0, 0, 640, 880);
    for (let i = 0; i < 6000; i++) { x.fillStyle = `rgba(255,255,255,${Math.random() * 0.03})`; x.fillRect(Math.random() * 640, Math.random() * 880, 1, 1); }
    x.strokeStyle = "rgba(255,255,255,0.14)"; x.lineWidth = 3;
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
      x.beginPath(); x.roundRect(28 + col * 198, 30 + row * 276, 188, 262, 12); x.stroke();
    }
  }
  const pageTex = r.textureFromCanvas(pageCanvas);
  const blank = r.textureFromCanvas(placeholder(""));

  Promise.all([ready, wallReady]).then(() => {
    loader.classList.add("done");
    setTimeout(() => loader.remove(), 900);
  });

  // ---------- input ----------
  let target = 0, p = 0, mx = 0, my = 0, smx = 0, smy = 0;
  const onScroll = () => {
    const rect = track.getBoundingClientRect();
    target = clamp01(-rect.top / Math.max(1, rect.height - innerHeight));
  };
  const onMove = (e: PointerEvent) => { mx = (e.clientX / innerWidth) * 2 - 1; my = (e.clientY / innerHeight) * 2 - 1; };
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("pointermove", onMove, { passive: true });
  onScroll();

  // ---------- choreography ----------
  // chapter windows in film progress
  const A = [0, 0.11], B = [0.11, 0.42], C = [0.42, 0.58], D = [0.58, 0.71], E = [0.71, 0.83], F = [0.83, 1];
  const fade = (x: number, a: number, b: number, edge = 0.025) => Math.min(range(x, a, a + edge), 1 - range(x, b - edge, b));
  const show = (e: El, o: number) => { e.style.opacity = o.toFixed(3); e.style.visibility = o < 0.01 ? "hidden" : "visible"; e.style.setProperty("--o", o.toFixed(3)); };

  let raf = 0, last = performance.now(), lastIdx = -1;
  const t0 = performance.now();
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    p = reduce ? target : lerp(p, target, 1 - Math.pow(0.0008, dt));
    smx = lerp(smx, mx, 1 - Math.pow(0.02, dt)); smy = lerp(smy, my, 1 - Math.pow(0.02, dt));
    const time = (now - t0) / 1000;
    const aspect = r.resize();
    const narrow = aspect < 0.9;
    const fov = narrow ? 0.9 : 0.62;

    // camera drifts a little with the pointer; pulls back for the wall
    const wallK = easeInOut(range(p, F[0], F[0] + 0.1));
    const camZ = lerp(narrow ? 3.4 : 2.6, narrow ? 8.4 : 6.6, wallK);
    const cam = [smx * 0.06, -smy * 0.04, camZ];
    const view = lookAt(cam, [0, 0, 0]);
    const proj = perspective(fov, aspect, 0.05, 50);
    const vp = multiply(proj, view);
    r.begin(vp, cam, [1.6, 2.4, 3.2], time);
    const T = (c: FilmCard) => tex.get(c.id) ?? blank;
    const side = narrow ? 0 : 1; // horizontal offset multiplier for desktop layouts
    const idle = reduce ? 0 : 1;

    // 1 · hero card (also the grading card later)
    const heroOut = range(p, A[1] - 0.03, A[1] + 0.04);
    const gradeIn = easeInOut(range(p, E[0] - 0.02, E[0] + 0.04));
    const gradeOut = range(p, E[1] - 0.02, E[1] + 0.02);
    if (p < A[1] + 0.05 || (p > E[0] - 0.03 && p < E[1] + 0.03)) {
      const inGrade = p > E[0] - 0.03;
      const k = inGrade ? gradeIn : 1 - heroOut;
      const x = inGrade ? lerp(1.2, 0.3 * side, gradeIn) : lerp(0.5 * side, 0.9, heroOut);
      const y = inGrade ? (narrow ? -0.33 : 0) : lerp(narrow ? 0.3 : 0, 0.6, heroOut);
      const rotY = inGrade ? lerp(-1.2, 0, gradeIn) + smx * 0.08 : -0.35 + smx * 0.45 + Math.sin(time * 0.6) * 0.08 * idle + heroOut * 2.2;
      const rotX = inGrade ? -smy * 0.05 : 0.12 + smy * 0.3 + Math.cos(time * 0.5) * 0.05 * idle;
      const rotZ = inGrade ? 0 : -0.08;
      const s = inGrade ? (narrow ? 1.05 : 1.2) : narrow ? 1.0 : 1.3;
      r.draw({ model: compose([x, y + Math.sin(time * 0.8) * 0.02 * idle * (inGrade ? 0 : 1), 0.2], [rotX, rotY, rotZ], s), tex: T(data.hero), foil: data.hero.foil, alpha: inGrade ? Math.min(gradeIn * 1.5, 1 - gradeOut) : clamp01(k * 1.4) });
    }

    // 2 · chase carousel drifting right to left
    const bp = range(p, B[0], B[1]);
    const n = data.chase.length;
    let centre = -1;
    if (p > B[0] - 0.04 && p < B[1] + 0.04 && n) {
      const travel = bp * (n - 1 + 1.2) - 0.6; // index at screen centre
      centre = Math.round(Math.max(0, Math.min(n - 1, travel)));
      data.chase.forEach((c, i) => {
        const d = i - travel;
        if (d > 3.2 || d < (narrow ? -3.2 : -1.25)) return;
        const gap = narrow ? 1.05 : 1.15;
        const x = d * gap + (narrow ? 0 : 0.55);
        const y = -d * (narrow ? 0.06 : 0.18) + (narrow ? 0.25 : 0);
        const z = -Math.abs(d) * 0.35;
        const enter = easeOut(range(p, B[0] - 0.04, B[0] + 0.02)) * (1 - range(p, B[1] - 0.02, B[1] + 0.04));
        r.draw({
          model: compose([x, y, z], [0.18 + smy * 0.12, -0.55 + d * 0.12 + smx * 0.25, -0.14], narrow ? 0.95 : 1.05),
          tex: T(c), foil: c.foil, alpha: enter * (1 - clamp01(Math.abs(d) - 2.2)) * (narrow ? 1 : clamp01((d + 1.25) * 2)),
        });
      });
    }

    // 3 · binder page: nine cards fly into their pockets
    const cp = range(p, C[0] - 0.02, C[1]);
    if (p > C[0] - 0.03 && p < C[1] + 0.03) {
      const pageIn = easeOut(range(cp, 0, 0.25));
      const out = range(p, C[1] - 0.02, C[1] + 0.02);
      const tilt = lerp(-0.9, -0.42, pageIn);
      const px = narrow ? 0 : 0.5, py = narrow ? -0.4 : -0.02;
      const scale = narrow ? 1.35 : 1.45;
      const page = compose([px, py, -0.05], [tilt, -0.2 - smx * 0.1, -0.05], [scale, scale, 0.4]);
      r.draw({ model: page, tex: pageTex, alpha: pageIn * (1 - out) });
      // pocket centres in page space (card box spans ±CARD_W/2 × ±CARD_H/2 at scale 1)
      data.page.slice(0, 9).forEach((c, i) => {
        const col = i % 3, row = Math.floor(i / 3);
        const local = [(col - 1) * (CARD_W / 3.05), (1 - row) * (CARD_H / 3.05), 0.012];
        const k = easeInOut(range(cp, 0.15 + i * 0.05, 0.45 + i * 0.05));
        // transform local pocket centre by the page matrix
        const m = page;
        const wx = m[0] * local[0] + m[4] * local[1] + m[8] * local[2] + m[12];
        const wy = m[1] * local[0] + m[5] * local[1] + m[9] * local[2] + m[13];
        const wz = m[2] * local[0] + m[6] * local[1] + m[10] * local[2] + m[14];
        const fromX = 2.4 + i * 0.2, fromY = 1.6 - i * 0.22, fromZ = 0.6;
        r.draw({
          model: compose([lerp(fromX, wx, k), lerp(fromY, wy, k), lerp(fromZ, wz, k)],
            [lerp(0.4, tilt, k), lerp(-1.8 + i * 0.3, -0.2 - smx * 0.1, k), lerp(0.5, -0.05, k)], lerp(1, scale / 3.3, k)),
          tex: T(c), foil: c.foil * 0.6, ghost: c.owned ? 0 : k * 0.85, alpha: clamp01(k * 3) * (1 - out),
        });
      });
    }

    // 4 · scan beam
    if (p > D[0] - 0.03 && p < D[1] + 0.03) {
      const dp = range(p, D[0], D[1]);
      const k = easeOut(range(p, D[0] - 0.03, D[0] + 0.03)) * (1 - range(p, D[1] - 0.02, D[1] + 0.03));
      const beam = 1 - range(dp, 0.1, 0.65);
      r.draw({ model: compose([narrow ? 0 : -0.5, narrow ? -0.38 : -0.02, 0.1], [0.05 - smy * 0.08, 0.3 + smx * 0.2, 0.02], narrow ? 1.0 : 1.2),
        tex: T(data.scan), foil: data.scan.foil, scan: dp > 0.1 && dp < 0.66 ? Math.max(0.001, beam) : 0, alpha: k });
    }

    // 6 · the set wall
    if (p > F[0] - 0.02 && wallTex) {
      const fp = range(p, F[0] - 0.02, F[1]);
      const rows = Math.ceil(data.wall.length / cols);
      const gw = CARD_W * 1.08, gh = CARD_H * 1.08;
      data.wall.forEach((c, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        const k = easeInOut(range(fp, (col + row) / (cols + rows) * 0.45, (col + row) / (cols + rows) * 0.45 + 0.35));
        const x = (col - (cols - 1) / 2) * gw, y = ((rows - 1) / 2 - row) * gh;
        const sx = Math.sin(i * 12.9898) * 6, sy = Math.cos(i * 78.233) * 4;
        r.draw({
          model: compose([lerp(sx, x, k), lerp(sy, y - (narrow ? 1.0 : 1.25), k), lerp(-6, -1.4, k)], [lerp(1.2, -0.4, k), lerp(-1.5, 0.1, k), lerp(0.6, 0, k)], 1),
          tex: wallTex!, rect: wallRects[i], foil: c.owned ? c.foil * 0.5 : 0, ghost: c.owned ? 0 : 0.92, alpha: clamp01(k * 2),
        });
      });
    }

    // ---------- overlays ----------
    show(hero, 1 - range(p, A[1] - 0.05, A[1]));
    show(chaseTitle, fade(p, B[0], B[0] + 0.09));
    show(meta, fade(p, B[0] + 0.09, B[1]));
    show(quotes, fade(p, B[0] + 0.02, B[1]));
    if (centre !== lastIdx && centre >= 0) {
      lastIdx = centre;
      const c = data.chase[centre];
      meta.innerHTML = `<p class="m-title">${esc(c.name)}</p>
        <dl><dt>Number</dt><dd>${esc(c.number)}</dd><dt>Rarity</dt><dd>${esc(c.rarity)}</dd><dt>Status</dt><dd>${esc(c.status)}</dd><dt>Priority</dt><dd>${esc(c.priority)}</dd></dl>`;
      quotes.innerHTML = `${c.price ? `<figure><span>Market</span><b>${esc(c.price)}</b></figure>` : ""}
        <figure><span>In your binder</span><b>${c.owned ? "Filed" : "Missing"}</b></figure>
        <figure><span>Card</span><b>${centre + 1} / ${n}</b></figure>`;
    }
    show(binderTitle, fade(p, C[0] + 0.02, C[1]));
    show(scanTitle, fade(p, D[0], D[1]));
    show(scanTag, fade(p, D[0] + 0.07, D[1]));
    show(gradeTitle, fade(p, E[0] + 0.02, E[1]));
    const gk = fade(p, E[0] + 0.05, E[1] - 0.01, 0.02);
    show(guides, gk);
    if (gk > 0) placeGuides(guides, vp, compose([0.3 * side, narrow ? -0.33 : 0, 0.2], [-smy * 0.05, smx * 0.08, 0], narrow ? 1.05 : 1.2), canvas);
    show(wallTitle, range(p, F[0] + 0.1, F[0] + 0.16));
    bar.classList.toggle("on-dark", false);
    root.style.setProperty("--p", p.toFixed(4));
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    removeEventListener("scroll", onScroll);
    removeEventListener("pointermove", onMove);
    r.destroy();
    root.classList.remove("film");
  };
}

/** Put the centering guides on the projected edges of the graded card. */
function placeGuides(box: El, vp: Float32Array, model: Float32Array, canvas: HTMLCanvasElement) {
  const m = multiply(vp, model);
  const project = (x: number, y: number) => {
    const X = m[0] * x + m[4] * y + m[12], Y = m[1] * x + m[5] * y + m[13], W = m[3] * x + m[7] * y + m[15];
    return [((X / W) * 0.5 + 0.5) * canvas.clientWidth, (1 - ((Y / W) * 0.5 + 0.5)) * canvas.clientHeight];
  };
  const w = CARD_W / 2, h = CARD_H / 2, inset = CARD_W * 0.065;
  const [lx, ty] = project(-w, h), [rx, by] = project(w, -h);
  const [ilx] = project(-w + inset, 0), [irx] = project(w - inset * 0.92, 0);
  const set = (sel: string, left: number) => { const g = box.querySelector(sel) as El; g.style.left = `${left}px`; g.style.top = `${ty - 20}px`; g.style.height = `${by - ty + 40}px`; };
  set(".ol", lx); set(".or", rx); set(".il", ilx); set(".ir", irx);
  const read = box.querySelector(".g-read") as El;
  read.style.left = `${rx + 28}px`; read.style.top = `${(ty + by) / 2 - 30}px`;
}
