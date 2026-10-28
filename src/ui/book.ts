// A zip-around trading card binder: a leather (or canvas / carbon) cover with a zipper
// that runs around three edges. Pull the tab to unzip, the cover swings open onto the
// inside cover, and pages turn like real pages: tap the edge, use the arrow keys, or drag.
import { h, reducedMotion } from "./dom.ts";
import type { Material } from "../lib/binders.ts";

export interface BookOptions {
  key: string; // remembers open state and page per binder
  title: string;
  subtitle?: string;
  logo?: string;
  color: string;
  material: Material;
  insideCover: () => HTMLElement;
  pages: (() => HTMLElement)[];
  pocketAspect: number; // page width / height
}

/** The binder's front cover (also used small on the shelf). */
export function coverEl(o: { title: string; subtitle?: string; logo?: string; color: string; material: Material }, cls = "") {
  const zip = h("div", { class: "zip", "aria-hidden": "true" },
    h("span", { class: "zip-seg top" }, h("i")), h("span", { class: "zip-seg right" }, h("i")), h("span", { class: "zip-seg bottom" }, h("i")),
    h("span", { class: "zip-pull", title: "Pull to unzip" }));
  return h("div", { class: `cover mat-${o.material} ${cls}`, style: `--cover:${o.color}` },
    h("div", { class: "cover-spine", "aria-hidden": "true" }),
    h("div", { class: "cover-stitch", "aria-hidden": "true" }),
    h("div", { class: "cover-badge" },
      o.logo ? h("img", { class: "cover-logo", src: o.logo + ".webp", alt: "", onerror: (e: Event) => ((e.target as HTMLElement).hidden = true) }) : null,
      h("strong", { class: "cover-title" }, o.title),
      o.subtitle ? h("span", { class: "cover-sub" }, o.subtitle) : null),
    zip);
}

const memory = new Map<string, { open: boolean; at: number }>();

export function book(o: BookOptions): HTMLElement {
  const stage = h("div", { class: "book-stage", tabindex: 0, "aria-label": `${o.title} binder` });
  const state = memory.get(o.key) ?? { open: false, at: 0 };
  memory.set(o.key, state);
  let busy = false;

  // sequence of single pages: inside cover, pages…, inside back cover
  const backCover = () => h("div", { class: "page-face lining back-lining" }, h("p", { class: "lining-note" }, `${o.pages.length} page${o.pages.length === 1 ? "" : "s"}`));
  const seq: (() => HTMLElement)[] = [o.insideCover, ...o.pages, ...(o.pages.length % 2 === 0 ? [backCover] : [])];
  const twoUp = () => stage.clientWidth >= 760;
  // In two-page mode position p is a spread: left = seq[2p], right = seq[2p + 1].
  const spreads = () => Math.ceil(seq.length / 2);
  const maxAt = () => (twoUp() ? spreads() - 1 : seq.length - 1);

  function size() {
    const avail = stage.clientWidth || 360;
    const maxH = Math.max(320, innerHeight - 270);
    const pageW = Math.min(twoUp() ? avail / 2 - 8 : avail - 4, maxH * o.pocketAspect);
    stage.style.setProperty("--page-w", `${Math.floor(pageW)}px`);
    stage.style.setProperty("--page-h", `${Math.floor(pageW / o.pocketAspect)}px`);
  }

  const page = (i: number) => {
    const f = seq[i];
    const el = f ? f() : h("div", { class: "page-face blank" });
    el.classList.add("page-face");
    return el;
  };

  // ---------- closed ----------
  const cover = () => coverEl(o);

  function drawClosed() {
    const c = cover();
    const btn = h("button", { class: "btn unzip", onclick: () => open() }, "Unzip binder");
    c.querySelector(".zip-pull")!.addEventListener("click", () => open());
    stage.replaceChildren(h("div", { class: `book closed ${twoUp() ? "two" : "one"}` }, h("div", { class: "book-body" }, c)), h("div", { class: "book-actions" }, btn));
    size();
  }

  // Animate the pull around top → right → bottom while the teeth part behind it.
  async function runZip(c: HTMLElement, opening: boolean) {
    if (reducedMotion()) return;
    const segs = ["top", "right", "bottom"].map((s) => c.querySelector(`.zip-seg.${s} i`) as HTMLElement);
    const pull = c.querySelector(".zip-pull") as HTMLElement;
    const W = c.clientWidth, H = c.clientHeight, m = 10;
    const pts = [[m + 18, m], [W - m, m], [W - m, H - m], [m + 18, H - m]];
    const lens = [W - 2 * m - 18, H - 2 * m, W - 2 * m - 18];
    const total = lens.reduce((a, b) => a + b, 0), dur = 1300;
    const order = opening ? [0, 1, 2] : [2, 1, 0];
    for (const i of order) {
      const t = (dur * lens[i]) / total;
      const [a, b] = opening ? [pts[i], pts[i + 1]] : [pts[i + 1], pts[i]];
      const axis = i === 1 ? "scaleY" : "scaleX";
      await Promise.all([
        pull.animate([{ left: `${a[0]}px`, top: `${a[1]}px` }, { left: `${b[0]}px`, top: `${b[1]}px` }], { duration: t, easing: "linear", fill: "forwards" }).finished,
        segs[i].animate([{ transform: `${axis}(${opening ? 0 : 1})` }, { transform: `${axis}(${opening ? 1 : 0})` }], { duration: t, easing: "linear", fill: "forwards" }).finished,
      ]);
    }
  }

  async function open() {
    if (busy || state.open) return;
    busy = true;
    const bookEl = stage.querySelector(".book") as HTMLElement;
    const c = stage.querySelector(".cover") as HTMLElement;
    stage.querySelector(".book-actions")?.remove();
    await runZip(c, true);
    state.open = true;
    state.at = 0;
    if (!reducedMotion()) {
      // swing the cover open onto the left page (two-up) or away (single page)
      bookEl.classList.add("opening");
      const under = twoUp() ? h("div", { class: "slot right" }, page(1)) : h("div", { class: "slot single" }, page(0));
      bookEl.querySelector(".book-body")!.prepend(under);
      const spot = h("div");
      c.replaceWith(spot);
      const leaf = h("div", { class: "leaf cover-leaf" }, h("div", { class: "leaf-face front" }, c), h("div", { class: "leaf-face back" }, page(0)));
      spot.replaceWith(leaf);
      if (twoUp()) bookEl.animate([{ transform: "translateX(calc(var(--page-w) * -0.5))" }, { transform: "translateX(0)" }], { duration: 900, easing: "cubic-bezier(.3,.7,.3,1)", fill: "forwards" });
      await leaf.animate([{ transform: "rotateY(0deg)" }, { transform: "rotateY(-180deg)" }], { duration: 900, easing: "cubic-bezier(.3,.7,.3,1)", fill: "forwards" }).finished;
    }
    busy = false;
    drawOpen();
  }

  async function close() {
    if (busy) return;
    busy = true;
    state.open = false;
    if (!reducedMotion()) {
      state.at = 0;
      drawOpen();
      const bookEl = stage.querySelector(".book") as HTMLElement;
      const left = bookEl.querySelector(".slot.left, .slot.single") as HTMLElement;
      const c = cover();
      const leaf = h("div", { class: "leaf cover-leaf", style: "transform: rotateY(-180deg)" }, h("div", { class: "leaf-face front" }, c), h("div", { class: "leaf-face back" }, page(0)));
      left?.replaceWith(twoUp() ? h("div", { class: "slot left ghost" }) : h("div", { class: "slot single ghost" }));
      bookEl.querySelector(".book-body")!.append(leaf);
      if (twoUp()) bookEl.animate([{ transform: "translateX(0)" }, { transform: "translateX(calc(var(--page-w) * -0.5))" }], { duration: 800, easing: "ease-in-out", fill: "forwards" });
      await leaf.animate([{ transform: "rotateY(-180deg)" }, { transform: "rotateY(0deg)" }], { duration: 800, easing: "ease-in-out", fill: "forwards" }).finished;
      drawClosed();
      const cv = stage.querySelector(".cover") as HTMLElement;
      cv.querySelectorAll(".zip-seg i").forEach((i) => ((i as HTMLElement).style.transform = (i.parentElement!.classList.contains("right") ? "scaleY(1)" : "scaleX(1)")));
      (cv.querySelector(".zip-pull") as HTMLElement).style.cssText = `left:${10 + 18}px; top:${cv.clientHeight - 10}px`;
      await runZip(cv, false);
    } else drawClosed();
    busy = false;
  }

  // ---------- open ----------
  function drawOpen() {
    state.at = Math.min(state.at, maxAt());
    const body = h("div", { class: "book-body" });
    if (twoUp()) body.append(h("div", { class: "slot left" }, page(2 * state.at)), h("div", { class: "slot right" }, page(2 * state.at + 1)));
    else body.append(h("div", { class: "slot single" }, page(state.at)));
    const label = twoUp()
      ? (state.at === 0 ? "Inside cover · page 1" : `Pages ${2 * state.at}–${Math.min(2 * state.at + 1, o.pages.length)}`)
      : (state.at === 0 ? "Inside cover" : `Page ${state.at} of ${o.pages.length}`);
    const bar = h("div", { class: "book-bar" },
      h("button", { class: "btn ghost page-btn", "aria-label": "Previous page", disabled: state.at === 0, onclick: () => turn(-1) }, "‹"),
      h("span", { class: "page-label" }, label),
      h("button", { class: "btn ghost page-btn", "aria-label": "Next page", disabled: state.at >= maxAt(), onclick: () => turn(1) }, "›"),
      h("button", { class: "btn ghost zip-close", onclick: () => close() }, "Zip it up"));
    stage.replaceChildren(bar, h("div", { class: `book open ${twoUp() ? "two" : "one"}` }, body));
    size();
    attachDrag(body);
  }

  /** Build the turning leaf for a page turn in direction dir (+1 forward, −1 back). */
  function leafFor(dir: number): { leaf: HTMLElement; to: number; under: () => void } | null {
    const at = state.at, body = stage.querySelector(".book-body") as HTMLElement;
    if (twoUp()) {
      if (dir > 0 && at < maxAt()) {
        const leaf = h("div", { class: "leaf" }, h("div", { class: "leaf-face front" }, page(2 * at + 1)), h("div", { class: "leaf-face back" }, page(2 * at + 2)));
        return { leaf, to: -180, under: () => body.querySelector(".slot.right")!.replaceChildren(page(2 * at + 3)) };
      }
      if (dir < 0 && at > 0) {
        const leaf = h("div", { class: "leaf from-left" }, h("div", { class: "leaf-face front" }, page(2 * at)), h("div", { class: "leaf-face back" }, page(2 * at - 1)));
        return { leaf, to: 180, under: () => body.querySelector(".slot.left")!.replaceChildren(page(2 * at - 2)) };
      }
      return null;
    }
    if (dir > 0 && at < maxAt()) {
      const leaf = h("div", { class: "leaf one" }, h("div", { class: "leaf-face front" }, page(at)), h("div", { class: "leaf-face back sleeve-back" }));
      return { leaf, to: -180, under: () => body.querySelector(".slot.single")!.replaceChildren(page(at + 1)) };
    }
    if (dir < 0 && at > 0) {
      const leaf = h("div", { class: "leaf one", style: "transform: rotateY(-180deg)" }, h("div", { class: "leaf-face front" }, page(at - 1)), h("div", { class: "leaf-face back sleeve-back" }));
      return { leaf, to: 0, under: () => {} };
    }
    return null;
  }

  async function turn(dir: number, from?: { leaf: HTMLElement; angle: number; to: number }) {
    if (busy) return;
    const made = from ? null : leafFor(dir);
    if (!from && !made) return;
    busy = true;
    const body = stage.querySelector(".book-body") as HTMLElement;
    let leaf: HTMLElement, start: number, to: number;
    if (from) ({ leaf, angle: start, to } = from);
    else {
      leaf = made!.leaf; to = made!.to;
      start = !twoUp() && dir < 0 ? -180 : 0;
      made!.under();
      body.append(leaf);
    }
    const dur = reducedMotion() ? 1 : 650 * Math.max(0.35, Math.abs(to - start) / 180);
    await leaf.animate([{ transform: `rotateY(${start}deg)` }, { transform: `rotateY(${to}deg)` }], { duration: dur, easing: "cubic-bezier(.25,.6,.3,1)", fill: "forwards" }).finished;
    state.at = Math.max(0, Math.min(maxAt(), state.at + dir));
    busy = false;
    drawOpen();
  }

  // Drag a page from its outer edge to turn it.
  function attachDrag(body: HTMLElement) {
    let start: { x: number; dir: number; leaf?: HTMLElement; to: number; moved: boolean } | null = null;
    body.addEventListener("pointerdown", (e) => {
      if (busy || e.button > 0) return;
      const r = body.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const dir = twoUp() ? (x > 0.5 ? 1 : -1) : x > 0.5 ? 1 : -1;
      start = { x: e.clientX, dir, to: 0, moved: false };
    });
    body.addEventListener("pointermove", (e) => {
      if (!start || busy) return;
      const dx = e.clientX - start.x;
      if (!start.leaf) {
        if (Math.abs(dx) < 14 || Math.sign(dx) !== -start.dir) return;
        const made = leafFor(start.dir);
        if (!made) { start = null; return; }
        made.under();
        body.append(made.leaf);
        start.leaf = made.leaf; start.to = made.to; start.moved = true;
        body.dataset.dragged = "1";
        body.setPointerCapture(e.pointerId);
      }
      const w = body.getBoundingClientRect().width / (twoUp() ? 2 : 1);
      const p = Math.max(0, Math.min(1, Math.abs(dx) / w));
      const base = !twoUp() && start.dir < 0 ? -180 : 0;
      start.leaf.style.transform = `rotateY(${base + (start.to - base) * p}deg)`;
      start.leaf.style.setProperty("--turn", String(p));
    });
    const end = async (e: PointerEvent) => {
      if (!start) return;
      const s = start;
      start = null;
      if (!s.leaf) return;
      setTimeout(() => delete body.dataset.dragged, 0);
      e.preventDefault();
      const w = body.getBoundingClientRect().width / (twoUp() ? 2 : 1);
      const p = Math.abs(e.clientX - s.x) / w;
      const base = !twoUp() && s.dir < 0 ? -180 : 0;
      const angle = base + (s.to - base) * Math.max(0, Math.min(1, p));
      if (p > 0.3) await turn(s.dir, { leaf: s.leaf, angle, to: s.to });
      else {
        busy = true;
        await s.leaf.animate([{ transform: `rotateY(${angle}deg)` }, { transform: `rotateY(${base}deg)` }], { duration: 250, fill: "forwards" }).finished;
        busy = false;
        drawOpen();
      }
    };
    body.addEventListener("pointerup", end);
    body.addEventListener("pointercancel", end);
    // a drag shouldn't also open the card under the finger
    body.addEventListener("click", (e) => { if (body.dataset.dragged) { e.stopPropagation(); e.preventDefault(); } }, true);
  }

  stage.addEventListener("keydown", (e) => {
    if (!state.open) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } return; }
    if (e.key === "ArrowRight") turn(1);
    if (e.key === "ArrowLeft") turn(-1);
  });
  let lastTwo: boolean | null = null;
  const ro = new ResizeObserver(() => {
    if (busy) return;
    const two = twoUp();
    if (two !== lastTwo) {
      lastTwo = two;
      if (state.open) {
        // convert position between single pages and spreads
        state.at = two ? Math.floor(state.at / 2) : state.at;
        drawOpen();
      } else drawClosed();
    } else size();
  });
  requestAnimationFrame(() => { ro.observe(stage); });
  if (state.open) drawOpen(); else drawClosed();
  return stage;
}
