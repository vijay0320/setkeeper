import { initSync, onSyncChange, syncEnabled, state as syncState, syncNow, sendLink, signOut, deleteCloudCopy, backupText, restore, hasPreSyncCopy, preSyncText, persistStorage } from "./syncRuntime.ts";
import setData from "../data/sets/30th-celebration.json";
import fpData from "../data/sets/30th-celebration.fingerprints.json";
import type { Card, CardSet, Collection, Entry, Priority, Status } from "./lib/types.ts";
import { PRIORITY_LABEL, STATUS_LABEL, owned, missing } from "./lib/types.ts";
import { load, save, updateEntry, updateSettings } from "./lib/store.ts";
import { checkPrice, estimatedCost, formatCAD, priorityOf, VERDICT_LABEL } from "./lib/pricing.ts";
import { plan, progress, insights } from "./lib/planner.ts";
import { exportCSV, importFile } from "./lib/transfer.ts";
import { identify, type RefFingerprint } from "./vision/match.ts";
import { detectEdges, centeringFrom, type Edges } from "./vision/centering.ts";
import { fileToCanvas, canvasToRGBA } from "./vision/browser.ts";
import sampleMarket from "../data/listings/sample.json";
import { listingsFromRows, type MarketSnapshot, type ShippingRule } from "./lib/market.ts";
import { optimizeCart, type CartPlan, type Want } from "./lib/cart.ts";
import { loadMarket, saveMarket, withOverrides, type MarketState } from "./lib/marketStore.ts";
import { parseCSV } from "./lib/transfer.ts";
import { readXlsx } from "./lib/xlsx.ts";
import { CONDITION_LABEL, TIER_LABEL, compareCompanies, reopenedSince, worstFrom, isOpen, type Condition, type ServicesFile, type TierStatus } from "./lib/grading.ts";
import servicesData from "../data/grading/services.json";
import galleriesData from "../data/galleries/index.json";
import { gallerySet, findPart, gallerySetId, partName, shortName, galleryUrl, type GalleryIndex, type DbSet } from "./lib/galleries.ts";
import { analysePacks, observedRates, DEFAULT_MODEL, type PackSession } from "./lib/packs.ts";
import { progress as groupProgress } from "./lib/planner.ts";

import { h, $ } from "./ui/dom.ts";
import { book, coverEl } from "./ui/book.ts";
import { mountFilm } from "./home3d/experience.ts";
import { stage, stopStages, type Scene, type StageCard } from "./home3d/stage.ts";
import { binder3d, stopBinders, type PocketItem } from "./home3d/binder3d.ts";
import { fingerprint } from "./vision/features.ts";
import {
  fetchSetList, fetchSet, setFrom, enrich, searchCards, rarityOrder, tcgdexIdFor30th,
  loadCatalog, saveCatalog, loadSetList, saveSetList, type CardInfo, type SetSummary,
} from "./lib/catalog.ts";
import {
  loadShelf, saveShelf, addSetBinder, addPersonalBinder, addSlot, moveSlot, removeSlot, paginate,
  COVER_COLORS, POCKET_GRID, type Binder, type Material, type Pockets, type Slot,
} from "./lib/binders.ts";

declare const __ARTIFACT__: boolean;
declare const __IMAGE_BASE__: string;

const BUNDLED = setData as unknown as CardSet;
const BUNDLED_REFS: RefFingerprint[] = Object.entries(fpData as Record<string, Omit<RefFingerprint, "id">>).map(([id, f]) => ({ id, ...f }));
let SET: CardSet = BUNDLED;
let REFS: RefFingerprint[] = BUNDLED_REFS;
let BY_ID = new Map(SET.cards.map((c) => [c.id, c]));
let col: Collection = load(SET.id);
let AUTO: Record<string, number> = {}; // market value from the card database, CAD
let shelf = loadShelf();
let setLoading = "";
let setError = "";
let enrichStatus = "";
let GALLERIES = galleriesData as unknown as GalleryIndex;

function imgUrl(c: { image?: string }, size: "low" | "high" = "low") {
  if (!c.image) return "";
  if (c.image.startsWith("2M6P")) return __IMAGE_BASE__ ? `${__IMAGE_BASE__}${c.image}.jpg` : BUNDLED.imageBase + c.image + BUNDLED.imageSuffix;
  if (/\.(png|jpe?g|webp)$/i.test(c.image)) return c.image; // official gallery image
  return c.image + (size === "high" ? "/high.webp" : "/low.webp");
}
const entry = (id: string): Entry => col.entries[id] ?? {};
const statusOf = (id: string): Status => entry(id).status ?? "need";
const marketOf = (id: string): number | undefined => entry(id).market ?? AUTO[id];
/** Entries with database market values filled in where the collector hasn't set one. */
function effEntries(): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  for (const c of SET.cards) { const e = entry(c.id); out[c.id] = e.market == null && AUTO[c.id] != null ? { ...e, market: AUTO[c.id] } : e; }
  return out;
}
const activeBinder = (): Binder => shelf.binders.find((b) => b.id === shelf.active) ?? shelf.binders[0];
const persistShelf = () => { if (!saveShelf(shelf)) toast("Couldn't save your binders in this browser."); };

// ---------- sets ----------
const fpKey = (setId: string) => `setkeeper:v1:fp:${setId}`;
function loadRefs(setId: string): RefFingerprint[] {
  if (setId === BUNDLED.id) return BUNDLED_REFS;
  try { const raw = localStorage.getItem(fpKey(setId)); return raw ? JSON.parse(raw) : []; } catch { return []; }
}
function autoFrom(info: Record<string, CardInfo>, mapId: (id: string) => string | undefined = (id) => BY_ID.get(id)?.ref ?? id): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of SET.cards) {
    const i = info[mapId(c.id) ?? ""];
    if (i?.usd) out[c.id] = Math.round(i.usd * col.settings.usdToCad * 100) / 100;
  }
  return out;
}
function applySet(set: CardSet, refs: RefFingerprint[]) {
  SET = set; REFS = refs; BY_ID = new Map(set.cards.map((c) => [c.id, c]));
  col = load(set.id);
  market = loadMarket(set.id);
  scoutTried = false; scans = []; gradeCard = ""; pageIndex = 0;
  const cache = loadCatalog(set.id);
  AUTO = cache ? autoFrom(cache.info, set.id === BUNDLED.id ? tcgdexIdFor30th : undefined) : {};
  completedBefore = completedGroups();
}

/** Make a set the one the tool tabs work on. Loads it from the card database if needed. */
async function activateSet(setId: string) {
  shelf.activeSet = setId;
  persistShelf();
  setError = "";
  if (setId === BUNDLED.id) {
    applySet(BUNDLED, BUNDLED_REFS);
    const c = loadCatalog(BUNDLED.id);
    // prices load in the background once the page has had a few seconds to draw
    if (!c?.enrichedAt || Date.now() - Date.parse(c.enrichedAt) > 3 * 86400000) setTimeout(() => refreshPrices(BUNDLED), 5000);
    return;
  }
  const gp = findPart(GALLERIES, setId);
  if (gp) { await activateGallerySet(setId, gp); return; }
  const cached = loadCatalog(setId);
  if (cached) {
    applySet(cached.set, loadRefs(setId));
    if (!cached.enrichedAt || Date.now() - Date.parse(cached.enrichedAt) > 3 * 86400000) refreshPrices(cached.set);
    return;
  }
  if (__ARTIFACT__) { setError = "This preview can't reach the card database. Every set is available in the installed app."; applySet(BUNDLED, BUNDLED_REFS); return; }
  setLoading = setId;
  render();
  try {
    const set = setFrom(await fetchSet(setId));
    saveCatalog({ set, fetchedAt: new Date().toISOString(), info: {} });
    applySet(set, loadRefs(setId));
    refreshPrices(set);
  } catch (e) {
    setError = `Couldn't load that set: ${(e as Error).message}. Check your connection and try again.`;
    applySet(BUNDLED, BUNDLED_REFS);
  }
  setLoading = "";
  render();
}

/**
 * Sets from the official galleries: card numbers and official categories from Pokémon's
 * gallery, names and prices from TCGdex once it has the set. A brand-new set opens from
 * the gallery alone and fills in when the database catches up.
 */
async function activateGallerySet(setId: string, gp: NonNullable<ReturnType<typeof findPart>>) {
  const cached = loadCatalog(setId);
  const fromGallery = cached?.set.sources.some((s) => s.includes("tcg.pokemon.com"));
  const hasDb = cached?.set.sources.some((s) => s.includes("tcgdex"));
  const stale = !cached || !fromGallery || (gp.p.tcgdex && !hasDb) || cached.set.cards.length < gp.p.count;
  if (cached && (!stale || __ARTIFACT__)) {
    applySet(cached.set, loadRefs(setId));
    if (!__ARTIFACT__ && hasDb && (!cached.enrichedAt || Date.now() - Date.parse(cached.enrichedAt) > 3 * 86400000)) refreshPrices(cached.set);
    return;
  }
  let db: DbSet | undefined;
  if (gp.p.tcgdex && !__ARTIFACT__) {
    setLoading = setId; render();
    try { db = (await fetchSet(gp.p.tcgdex)) as unknown as DbSet; } catch { /* gallery alone */ }
    setLoading = "";
  }
  const set = gallerySet(GALLERIES.imageHost, gp.g, gp.p, db, setId);
  if (cached) set.cards = set.cards.map((c) => ({ ...c, rarity: cached.set.cards.find((x) => x.id === c.id)?.rarity ?? c.rarity }));
  saveCatalog({ set, fetchedAt: new Date().toISOString(), info: cached?.info ?? {}, ...(cached?.enrichedAt ? { enrichedAt: cached.enrichedAt } : {}) });
  applySet(set, loadRefs(setId));
  if (db) refreshPrices(set);
  render();
}

/** Fetch rarity and market prices for every card in the background. */
async function refreshPrices(set: CardSet) {
  if (__ARTIFACT__) return;
  const bundled = set.id === BUNDLED.id;
  const dbId = (c: Card) => (bundled ? tcgdexIdFor30th(c.id) : c.ref ?? (c.id.startsWith("g-") ? undefined : c.id));
  const ids = set.cards.map(dbId).filter((x): x is string => !!x);
  if (!ids.length) return;
  enrichStatus = "Loading prices…";
  renderHeader();
  const info = await enrich(ids, (d, t) => { enrichStatus = `Loading prices ${d}/${t}`; if (d % 20 === 0 || d === t) renderHeader(); });
  enrichStatus = "";
  const cache = loadCatalog(set.id) ?? { set, fetchedAt: new Date().toISOString(), info: {} };
  cache.info = { ...cache.info, ...info };
  cache.enrichedAt = new Date().toISOString();
  if (!bundled) {
    cache.set.cards = cache.set.cards.map((c) => ({ ...c, rarity: info[c.ref ?? c.id]?.rarity ?? c.rarity }));
    cache.set.rarities = rarityOrder(cache.set.cards.map((c) => c.rarity));
  }
  saveCatalog(cache);
  if (SET.id === set.id) {
    if (!bundled) { SET = cache.set; BY_ID = new Map(SET.cards.map((c) => [c.id, c])); }
    AUTO = autoFrom(cache.info, bundled ? tcgdexIdFor30th : undefined);
    render();
  }
}

function persist(quiet = false) {
  const now = completedGroups();
  const fresh = [...now].filter((g) => !completedBefore.has(g));
  if (fresh.length) {
    col.badges = [...(col.badges ?? []), ...fresh.filter((g) => !col.badges?.some((b) => b.label === g)).map((label) => ({ label, date: new Date().toISOString().slice(0, 10) }))];
    if (!quiet) celebrate(fresh[fresh.length - 1]);
  }
  completedBefore = now;
  if (!save(col)) toast("Couldn't save in this browser. Export a backup from Data.");
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2600);
}

function cardThumb(c: Card, cls = "") {
  const url = imgUrl(c);
  return url
    ? h("img", { class: "thumb " + cls, src: url, alt: `${c.name} ${c.number}`, loading: "lazy", decoding: "async" })
    : h("div", { class: "thumb ph " + cls }, h("span", {}, c.name.replace("Basic ", "").replace(" Energy", "")), h("small", {}, c.number));
}

const FOIL: Record<string, string> = {
  "Special Art Rare": "rainbow", "Special Art ex": "rainbow", "Futuristic Rare": "cosmos", "RGB Mew": "rainbow",
  Classic: "gold", "Pikachu Rare": "sparkle", "Double Rare (ex)": "sparkle",
};
/** Card image with a foil layer that follows the pointer (owned cards only get the shine). */
function foilFor(rarity: string): string {
  if (FOIL[rarity]) return FOIL[rarity];
  if (/futuristic/i.test(rarity)) return "cosmos";
  if (/hyper|gold/i.test(rarity)) return "gold";
  if (/special illustration|secret|rainbow|shiny/i.test(rarity)) return "rainbow";
  if (/holo|ultra|double|illustration|vmax|vstar|\bex\b|gx|prime|legend|break|ace/i.test(rarity)) return "sparkle";
  return "sheen";
}
function holoCard(c: Card, cls = "", live = owned(statusOf(c.id))) {
  return h("div", { class: `holo ${live ? "live" : ""} ${cls}`, "data-foil": foilFor(c.rarity) }, cardThumb(c), h("span", { class: "shine", "aria-hidden": "true" }));
}

function tilt(el: HTMLElement, x: number, y: number) {
  el.style.setProperty("--rx", `${(0.5 - y) * 18}deg`);
  el.style.setProperty("--ry", `${(x - 0.5) * 22}deg`);
  el.style.setProperty("--mx", `${x * 100}%`);
  el.style.setProperty("--my", `${y * 100}%`);
  el.style.setProperty("--o", "1");
}
function setupHolo() {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let frame = 0;
  document.addEventListener("pointermove", (e) => {
    if (reduce || e.pointerType === "touch" && e.buttons === 0) return;
    const el = (e.target as HTMLElement).closest?.(".holo.live") as HTMLElement | null;
    if (!el) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      tilt(el, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    });
  });
  document.addEventListener("pointerout", (e) => {
    const el = (e.target as HTMLElement).closest?.(".holo.live") as HTMLElement | null;
    if (el && !el.contains(e.relatedTarget as Node)) { el.style.removeProperty("--rx"); el.style.removeProperty("--ry"); el.style.setProperty("--o", "0"); }
  });
  // Phones: tilt the big card in the detail sheet with the device.
  window.addEventListener("deviceorientation", (e) => {
    if (reduce || e.beta == null || e.gamma == null) return;
    const el = document.querySelector("#sheet[open] .holo.live") as HTMLElement | null;
    if (!el) return;
    tilt(el, Math.min(1, Math.max(0, 0.5 + e.gamma / 50)), Math.min(1, Math.max(0, 0.5 + (e.beta - 40) / 50)));
  });
}

// ---------- completion moments ----------
function completedGroups(): Set<string> {
  const done = new Set<string>();
  const sections = groupProgress(SET.cards, col.entries, "section");
  const sameAsSection = (ids: string) => sections.some((x) => SET.cards.filter((c) => c.section === x.label).map((c) => c.id).join() === ids);
  for (const g of sections) if (g.missing.length === 0) done.add(g.label);
  for (const g of groupProgress(SET.cards, col.entries, "rarity")) {
    // skip rarities that are the same cards as a section (Energy = Basic Energy, Classic = Classic Collection)
    if (g.missing.length === 0 && !sameAsSection(SET.cards.filter((c) => c.rarity === g.label).map((c) => c.id).join())) done.add(g.label);
  }
  if (SET.cards.every((c) => owned(statusOf(c.id)))) done.add(`the whole ${SET.name} set`);
  return done;
}
let completedBefore = new Set<string>();

function celebrate(label: string) {
  toast(`Completed ${label}!`);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cv = h("canvas", { class: "confetti", "aria-hidden": "true" });
  document.body.append(cv);
  const ctx = cv.getContext("2d")!;
  const W = (cv.width = innerWidth), H = (cv.height = innerHeight);
  const colors = ["#e2b65a", "#c9302c", "#2e5e9e", "#f5d77a", "#ffffff", "#6fd39b"];
  const bits = Array.from({ length: 160 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * 120, y: H * 0.35, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
    w: 6 + Math.random() * 6, h: 3 + Math.random() * 4, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const t0 = performance.now();
  const step = (t: number) => {
    ctx.clearRect(0, 0, W, H);
    for (const b of bits) {
      b.vy += 0.35; b.vx *= 0.99; b.x += b.vx; b.y += b.vy; b.r += b.vr;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); ctx.restore();
    }
    if (t - t0 < 2200) requestAnimationFrame(step); else cv.remove();
  };
  requestAnimationFrame(step);
}

const STATUS_ORDER: Status[] = ["have", "need", "in-store", "ordered", "upgrade"];

// ---------- views ----------
const VIEWS = ["home", "shelf", "binder", "scan", "buy", "packs", "grade", "stats", "data", "shop"] as const;
const NAV: View[] = ["shelf", "binder", "scan", "buy", "packs", "grade", "stats", "data"];
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = { home: "Home", shelf: "Shelf", binder: "Binder", scan: "Scan", shop: "Plan", buy: "Buy", packs: "Packs", grade: "Grade", stats: "Stats", data: "Data" };

function currentView(): View {
  const v = location.hash.slice(1) as View;
  return VIEWS.includes(v) ? v : "home";
}

function render() {
  const v = currentView();
  document.querySelectorAll<HTMLAnchorElement>("nav a").forEach((a) => a.setAttribute("aria-current", a.dataset.view === (v === "shop" ? "buy" : v) ? "page" : "false"));
  const main = $("#main");
  if (setLoading && v !== "shelf") { main.replaceChildren(h("section", { class: "view" }, h("p", { class: "loading" }, "Opening the set…"))); renderHeader(); return; }
  homeAbort?.abort();
  main.classList.toggle("home-main", v === "home");
  document.body.classList.toggle("is-home", v === "home");
  if (v !== lastView) { window.scrollTo({ top: 0 }); lastView = v; }
  stopStages();
  stopBinders();
  const changed = main.dataset.view !== v;
  main.dataset.view = v;
  main.replaceChildren(({ home, shelf: shelfView, binder, scan, shop, buy, packs, grade, stats, data } as Record<View, () => Node>)[v]());
  if (changed && v !== "home") { main.classList.remove("enter"); void main.offsetWidth; main.classList.add("enter"); }
  if (setError) { main.prepend(h("p", { class: "notice" }, setError)); setError = ""; }
  renderHeader();
}

function renderHeader() {
  const own = SET.cards.filter((c) => owned(statusOf(c.id))).length;
  $("#set-name").textContent = enrichStatus ? `${SET.name} · ${enrichStatus}` : SET.name;
  $("#progress-text").textContent = `${own}/${SET.cards.length}`;
  ($("#progress-bar") as HTMLElement).style.setProperty("--p", String(own / SET.cards.length));
}

// ---------- Masthead: every tab opens like a chapter of the film ----------
function stageCard(c: Card): StageCard {
  const f = foilFor(c.rarity);
  return { id: c.id, name: c.name, tex: texUrl(c, "high"), foil: f === "rainbow" || f === "cosmos" ? 1 : f === "gold" ? 0.8 : f === "sparkle" ? 0.6 : 0.25, ghost: !owned(statusOf(c.id)) };
}
const RANK: Record<Priority, number> = { chase: 0, high: 1, normal: 2, low: 3 };
function bestCards(filter: (c: Card) => boolean, n: number): Card[] {
  return SET.cards.filter((c) => c.image && filter(c))
    .sort((a, b) => RANK[priorityOf(a, entry(a.id))] - RANK[priorityOf(b, entry(b.id))] || (marketOf(b.id) ?? 0) - (marketOf(a.id) ?? 0))
    .slice(0, n);
}
const ownedTop = (n: number) => { const o = bestCards((c) => owned(statusOf(c.id)), n); return o.length ? o : bestCards(() => true, n); };
const missingTop = (n: number) => { const m = bestCards((c) => missing(statusOf(c.id)), n); return m.length ? m : ownedTop(n); };

interface Mast { kicker: string; title: string; lede?: string; meta?: [string, string][]; actions?: Node[]; scene?: Scene | null }
function masthead(m: Mast): HTMLElement {
  return h("header", { class: `mast${m.scene ? "" : " no-stage"}` },
    h("div", { class: "mast-copy" },
      h("p", { class: "mast-kicker" }, m.kicker),
      h("h1", { class: "mast-title" }, m.title),
      m.lede ? h("p", { class: "mast-lede" }, m.lede) : null,
      m.actions?.length ? h("div", { class: "mast-actions" }, ...m.actions) : null),
    m.scene ? stage(m.scene, "mast-stage") : null,
    m.meta?.length ? h("dl", { class: "mast-meta" }, ...m.meta.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])) : null);
}
const progressMeta = (): [string, string][] => {
  const own = SET.cards.filter((c) => owned(statusOf(c.id))).length;
  return [["Owned", `${own} / ${SET.cards.length}`], ["Complete", `${Math.round((100 * own) / (SET.cards.length || 1))}%`],
    ["Missing", String(SET.cards.filter((c) => missing(statusOf(c.id))).length)], ["In store", String(SET.cards.filter((c) => statusOf(c.id) === "in-store").length)]];
};

// ---------- Binder ----------
const filters = { show: "all", group: "all", q: "" };
let binderMode: "pages" | "grid" = (() => { try { return (localStorage.getItem("setkeeper:binderMode") as "pages" | "grid") || "pages"; } catch { return "pages"; } })();
let pageIndex = 0;

function binder(): Node {
  const b = activeBinder();
  if (b.kind === "personal") return personalBinder(b);
  if (b.setId !== SET.id) { void activateSet(b.setId!).then(render); return h("section", { class: "view" }, h("p", { class: "loading" }, "Opening the binder…")); }
  const chips = h("div", { class: "chips", role: "group", "aria-label": "Show" },
    ...[["all", "All"], ["missing", "Missing"], ["have", "Have"], ["in-store", "In store"], ["ordered", "Ordered"]].map(([k, l]) =>
      h("button", { class: "chip", "aria-pressed": String(filters.show === k), onclick: () => { filters.show = k; render(); } }, l)));
  const groupSel = h("select", { id: "group", "aria-label": "Section or rarity", onchange: (e: Event) => { filters.group = (e.target as HTMLSelectElement).value; render(); } },
    h("option", { value: "all" }, "Every section"),
    h("optgroup", { label: "Section" }, ...SET.sections.map((s) => h("option", { value: "s:" + s, selected: filters.group === "s:" + s }, s))),
    h("optgroup", { label: "Rarity" }, ...SET.rarities.map((r) => h("option", { value: "r:" + r, selected: filters.group === "r:" + r }, r))));
  let typing = 0;
  const search = h("input", { id: "q", type: "search", placeholder: "Search name or number", value: filters.q,
    oninput: (e: Event) => { filters.q = (e.target as HTMLInputElement).value; clearTimeout(typing); typing = window.setTimeout(() => (binderMode === "grid" ? drawGrid() : drawBook()), 250); } });
  const grid = h("div", { class: "grid", id: "grid" });
  const count = h("p", { class: "count", id: "count" });
  const holder = h("div", { class: "book-holder" });

  function drawGrid() {
    const list = filteredCards();
    count.textContent = `${list.length} card${list.length === 1 ? "" : "s"}`;
    grid.replaceChildren(...list.map(pocket));
  }
  function drawBook() {
    const list = filteredCards();
    const [cols, rows] = POCKET_GRID[b.pockets];
    const own = SET.cards.filter((c) => owned(statusOf(c.id))).length;
    const pages = paginate(list, b.pockets).map((cards, i) => () => pocketPage(cards, i + 1, cols, rows));
    const items: PocketItem[] = list.map((c) => { const st = statusOf(c.id); return { kind: "card", name: c.name, number: c.number, image: texUrl(c, "low"), owned: owned(st), status: STATUS_LABEL[st] }; });
    const jumps: { label: string; page: number }[] = [];
    list.forEach((c, i) => { if (!jumps.some((j) => j.label === c.section)) jumps.push({ label: c.section, page: Math.floor(i / b.pockets) + 1 }); });
    const gl3d = binder3d({
      key: b.id + "|" + filters.show + filters.group + filters.q, title: b.name, subtitle: SET.series || "Pokémon TCG", color: b.color, material: b.material,
      cols, rows, items, owner: b.owner, progress: { have: own, total: SET.cards.length }, jumps: jumps.length > 1 ? jumps : undefined,
      onCard: (i) => openCard(list[i].id),
    });
    holder.replaceChildren(gl3d ?? book({
      key: b.id, title: b.name, subtitle: SET.series || "Pokémon TCG", logo: b.logo ?? SET.logo, color: b.color, material: b.material,
      pocketAspect: (cols * 63 + 40) / (rows * 88 + 60), pages,
      insideCover: () => insideCover(b, `${SET.series || "Set binder"} · ${SET.cards.length} cards`, own, SET.cards.length, pages.length),
    }));
  }
  const modeSeg = h("div", { class: "seg small", role: "radiogroup", "aria-label": "Layout" },
    ...(["pages", "grid"] as const).map((m) => h("button", { role: "radio", "aria-checked": String(binderMode === m),
      onclick: () => { binderMode = m; try { localStorage.setItem("setkeeper:binderMode", m); } catch { /* ignore */ } render(); } }, m === "pages" ? "Binder" : "Grid")));
  const toolbar = h("div", { class: "toolbar" }, h("div", { class: "row between" }, chips, modeSeg), h("div", { class: "row" }, groupSel, search));
  const mast = masthead({
    kicker: `${SET.series || "Pokémon TCG"}${SET.releaseDate ? ` · ${SET.releaseDate.slice(0, 4)}` : ""}`,
    title: b.name,
    lede: "Unzip it and turn the pages. Owned cards sit in colour, missing ones wait as ghosts in their pockets. Tap any card for its details.",
    meta: progressMeta(),
    scene: { kind: "fan", cards: ownedTop(5).map(stageCard) },
  });
  const galleryOnly = SET.sources.some((x) => x.includes("tcg.pokemon.com/en-us/galleries")) && !SET.sources.some((x) => x.includes("tcgdex"));
  const note = galleryOnly ? h("p", { class: "hint gallery-note" }, "Just released: cards come straight from the ",
    h("a", { href: SET.sources[0], target: "_blank", rel: "noopener" }, "official gallery"),
    ". Names, prices and the card art in the 3D binder fill in automatically once the card database adds the set; Grid view shows the official images now.") : "";
  if (binderMode === "pages") { drawBook(); return h("section", { class: "view" }, mast, toolbar, note, holder); }
  drawGrid();
  return h("section", { class: "view" }, mast, toolbar, note, count, grid);
}

function pocketPage(cards: Card[], n: number, cols: number, rows: number) {
  const ownedHere = cards.filter((c) => owned(statusOf(c.id))).length;
  return h("div", { class: "page-face" },
    h("div", { class: "pockets", style: `--cols:${cols};--rows:${rows}` }, ...cards.map((c) => {
      const st = statusOf(c.id);
      return h("button", { class: `sleeve st-${st}`, "aria-label": `${c.name} ${c.number}, ${STATUS_LABEL[st]}`, onclick: () => openCard(c.id) },
        holoCard(c), owned(st) ? null : h("span", { class: "slot-num" }, c.number));
    }), ...Array.from({ length: cols * rows - cards.length }, () => h("div", { class: "sleeve empty" }))),
    h("p", { class: "page-foot" }, `Page ${n} · ${ownedHere}/${cards.length}`));
}

function insideCover(b: Binder, sub: string, have: number, total: number, pageCount: number) {
  const pct = total ? Math.round((100 * have) / total) : 0;
  return h("div", { class: "page-face lining", style: `--cover:${b.color}` },
    h("div", { class: "nameplate" },
      b.kind === "set" && (b.logo ?? SET.logo) ? h("img", { src: (b.logo ?? SET.logo) + ".webp", alt: "", onerror: (e: Event) => ((e.target as HTMLElement).hidden = true) }) : null,
      h("h3", {}, b.name),
      h("span", { class: "np-sub" }, sub),
      b.kind === "set" ? h("div", { class: "ring", style: `--p:${pct}` }, h("b", {}, `${pct}%`)) : h("div", { class: "ring", style: "--p:100" }, h("b", {}, String(total))),
      h("span", {}, b.kind === "set" ? `${have} of ${total} cards` : `${total} card${total === 1 ? "" : "s"}`),
      h("label", { class: "owner" }, "Property of", h("input", { id: `owner-${b.id}`, value: b.owner ?? "", "aria-label": "Owner name",
        onpointerdown: (e: Event) => e.stopPropagation(),
        onchange: (e: Event) => { b.owner = (e.target as HTMLInputElement).value || undefined; persistShelf(); } }))),
    h("p", { class: "lining-note" }, `${pageCount} page${pageCount === 1 ? "" : "s"} · ${b.pockets}-pocket`));
}

// ---------- Personal binders ----------
function slotCard(sl: Slot): Card {
  return { id: sl.ref, section: sl.setName ?? "", number: sl.number, name: sl.name, rarity: "", ...(sl.image ? { image: sl.image } : {}) };
}

function personalBinder(b: Binder): Node {
  const slots = b.slots ?? [];
  const [cols, rows] = POCKET_GRID[b.pockets];
  const items: (Slot | "add")[] = [...slots, "add"];
  const pages = paginate(items, b.pockets).map((pageItems, i) => () => h("div", { class: "page-face" },
    h("div", { class: "pockets", style: `--cols:${cols};--rows:${rows}` }, ...pageItems.map((it, k) => {
      if (it === "add") return h("button", { class: "sleeve add-pocket", onclick: () => openSearch(b) }, "+ Add a card");
      const idx = i * b.pockets + k;
      const c = slotCard(it);
      return h("button", { class: "sleeve st-have", "aria-label": `${it.name} ${it.number}`, onclick: () => openSlot(b, idx) }, holoCard(c, "", true));
    }), ...Array.from({ length: b.pockets - pageItems.length }, () => h("div", { class: "sleeve empty" }))),
    h("p", { class: "page-foot" }, `Page ${i + 1}`)));
  const gl3d = binder3d({
    key: b.id, title: b.name, subtitle: "Personal collection", color: b.color, material: b.material, cols, rows, owner: b.owner,
    progress: undefined,
    items: [...slots.map((sl): PocketItem => ({ kind: "card", name: sl.name, number: sl.number, image: slotImage(sl), owned: true })), { kind: "add" }],
    onCard: (i) => openSlot(b, i), onAdd: () => openSearch(b),
  });
  const holder = h("div", { class: "book-holder" }, gl3d ?? book({
    key: b.id, title: b.name, subtitle: "Personal collection", color: b.color, material: b.material,
    pocketAspect: (cols * 63 + 40) / (rows * 88 + 60), pages,
    insideCover: () => insideCover(b, "Personal binder", slots.length, slots.length, pages.length),
  }));
  const fanCards: StageCard[] = slots.slice(0, 5).map((sl) => ({ id: sl.ref, name: sl.name, tex: sl.image ? (sl.image.startsWith("2M6P") ? texUrl(slotCard(sl), "high") : `${sl.image}/high.webp`) : "", foil: 0.8 }));
  function slotImage(sl: Slot) { return sl.image ? (sl.image.startsWith("2M6P") ? texUrl(slotCard(sl), "low") : `${sl.image}/low.webp`) : ""; }
  return h("section", { class: "view" },
    masthead({
      kicker: "Personal binder", title: b.name,
      lede: slots.length ? "Your own picks from any set, in the order you choose. Tap a card to move it, add a note or take it out." : "Unzip it and tap “Add a card”, or add cards from any set binder's card page.",
      meta: [["Cards", String(slots.length)], ["Pages", String(Math.max(1, Math.ceil((slots.length + 1) / b.pockets)))], ["Pockets", `${b.pockets} a page`], ["Cover", b.material[0].toUpperCase() + b.material.slice(1)]],
      actions: [h("button", { class: "btn", onclick: () => openSearch(b) }, "Add cards"), h("button", { class: "btn ghost", onclick: () => editBinder(b) }, "Edit binder")],
      scene: fanCards.length ? { kind: "fan", cards: fanCards } : null,
    }),
    holder);
}

function openSlot(b: Binder, idx: number) {
  const sl = b.slots![idx];
  const dlg = $("#sheet") as HTMLDialogElement;
  let armed = false;
  const del = h("button", { class: "btn ghost", onclick: () => {
    if (!armed) { armed = true; del.textContent = "Tap again to remove"; return; }
    removeSlot(b, idx); persistShelf(); dlg.close(); toast("Removed from the binder");
  } }, "Remove");
  dlg.replaceChildren(h("form", { method: "dialog", class: "sheet-inner" },
    h("header", { class: "sheet-head" },
      h("div", {}, h("p", { class: "eyebrow" }, `${b.name} · pocket ${idx + 1}`), h("h2", {}, sl.name), h("p", { class: "num" }, `${sl.setName ?? sl.setId} · ${sl.number}`)),
      h("button", { class: "close", value: "close", "aria-label": "Close" }, "×")),
    h("div", { class: "sheet-body" },
      h("div", { class: "big" }, holoCard(slotCard(sl), "large", true)),
      h("div", { class: "fields" },
        h("label", { class: "field" }, h("span", {}, "Note"), h("textarea", { id: "slot-note", rows: 3, value: sl.note ?? "",
          onchange: (e: Event) => { sl.note = (e.target as HTMLTextAreaElement).value || undefined; persistShelf(); } })),
        h("div", { class: "row" },
          h("button", { class: "btn ghost", disabled: idx === 0, onclick: (e: Event) => { e.preventDefault(); moveSlot(b, idx, idx - 1); persistShelf(); dlg.close(); } }, "← Earlier"),
          h("button", { class: "btn ghost", disabled: idx >= b.slots!.length - 1, onclick: (e: Event) => { e.preventDefault(); moveSlot(b, idx, idx + 1); persistShelf(); dlg.close(); } }, "Later →"),
          del)))));
  dlg.onclose = () => render();
  dlg.showModal();
}

/** Find cards from any set to put in a personal binder. */
function openSearch(b: Binder) {
  const dlg = $("#sheet") as HTMLDialogElement;
  const results = h("div", { class: "search-hits" });
  const status = h("p", { class: "hint", role: "status" }, __ARTIFACT__ ? "Search the 30th Celebration cards. The installed app searches every set." : "Type a Pokémon or card name.");
  const setNames = new Map<string, string>((loadSetList()?.sets ?? []).map((x) => [x.id, x.name]));
  setNames.set(BUNDLED.id, BUNDLED.name);
  let timer = 0, added = 0;
  const show = (hits: { ref: string; setId: string; name: string; number: string; image?: string }[]) => {
    results.replaceChildren(...hits.slice(0, 60).map((x) => h("button", { class: "hit", onclick: () => {
      addSlot(b, { ref: x.ref, setId: x.setId, setName: setNames.get(x.setId) ?? x.setId, name: x.name, number: x.number, image: x.image });
      persistShelf(); added++; toast(`Added ${x.name} to ${b.name}`);
    } }, cardThumb({ id: x.ref, section: "", number: x.number, name: x.name, rarity: "", image: x.image }, "mini-hit"),
      h("b", {}, x.name), h("small", {}, `${setNames.get(x.setId) ?? x.setId} · ${x.number}`))));
  };
  const local = (q: string) => {
    const out: { ref: string; setId: string; name: string; number: string; image?: string }[] = [];
    for (const c of BUNDLED.cards) if (c.name.toLowerCase().includes(q)) out.push({ ref: `${BUNDLED.id}/${c.id}`, setId: BUNDLED.id, name: c.name, number: c.number, image: c.image });
    return out;
  };
  const input = h("input", { id: "card-search", type: "search", placeholder: "e.g. Umbreon, Charizard ex", autocomplete: "off",
    oninput: () => {
      clearTimeout(timer);
      const q = input.value.trim().toLowerCase();
      if (q.length < 2) { results.replaceChildren(); return; }
      timer = window.setTimeout(async () => {
        const mine = local(q);
        show(mine);
        if (__ARTIFACT__) { status.textContent = `${mine.length} cards`; return; }
        status.textContent = "Searching every set…";
        try {
          const hits = await searchCards(q);
          if (!setNames.size || setNames.size < 5) {
            try { const l = await fetchSetList(); saveSetList(l); l.sets.forEach((x) => setNames.set(x.id, x.name)); } catch { /* names optional */ }
          }
          const remote = hits.filter((x) => !x.setId.startsWith("30th") && !x.setId.startsWith("A") && !x.setId.startsWith("B"))
            .map((x) => ({ ref: x.id, setId: x.setId, name: x.name, number: x.localId, image: x.image }));
          show([...mine, ...remote]);
          status.textContent = `${mine.length + remote.length} cards`;
        } catch { status.textContent = "Couldn't reach the card database. Showing 30th Celebration cards only."; }
      }, 300);
    } }) as HTMLInputElement;
  dlg.replaceChildren(h("form", { method: "dialog", class: "sheet-inner" },
    h("header", { class: "sheet-head" }, h("div", {}, h("p", { class: "eyebrow" }, b.name), h("h2", {}, "Add cards")),
      h("button", { class: "close", value: "close", "aria-label": "Close" }, "×")),
    h("div", { class: "sheet-pad" }, input, status, results)));
  dlg.onclose = () => { if (added) render(); };
  dlg.showModal();
  input.focus();
}

// ---------- Home ----------
let homeAbort: AbortController | null = null;

function setZip(cover: HTMLElement, z: number) {
  const segs = ["top", "right", "bottom"].map((x) => cover.querySelector(`.zip-seg.${x} i`) as HTMLElement | null);
  const pull = cover.querySelector(".zip-pull") as HTMLElement | null;
  if (!pull || segs.some((x) => !x)) return;
  const W = cover.clientWidth, H = cover.clientHeight, m = 10;
  const lens = [W - 2 * m - 18, H - 2 * m, W - 2 * m - 18];
  const total = lens.reduce((a, b) => a + b, 0);
  let d = z * total;
  const pts = [[m + 18, m], [W - m, m], [W - m, H - m], [m + 18, H - m]];
  for (let i = 0; i < 3; i++) {
    const f = Math.max(0, Math.min(1, d / lens[i]));
    segs[i]!.style.transform = i === 1 ? `scaleY(${f})` : `scaleX(${f})`;
    if (d >= 0 && d <= lens[i]) {
      pull.style.left = `${pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f}px`;
      pull.style.top = `${pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f}px`;
    }
    d -= lens[i];
  }
  if (z >= 1) { pull.style.left = `${pts[3][0]}px`; pull.style.top = `${pts[3][1]}px`; }
}

let filmCleanup: (() => void) | null = null;
let lastView = "";

function texUrl(c: Card, size: "high" | "low"): string {
  if (!c.image) return "";
  if (c.image.startsWith("2M6P")) {
    if (__IMAGE_BASE__) return `${__IMAGE_BASE__}${c.image}.jpg`;
    // The official CDN doesn't allow 3D (WebGL) use from other sites, and TCGdex is missing
    // art for a third of this set, so small copies of the bundled set ship with the site.
    // Large views try TCGdex's sharper image first and fall back to the local copy.
    const local = `cards/${c.image}.jpg`;
    const t = size === "high" ? tcgdexIdFor30th(c.id) : undefined;
    const m = t?.match(/^(30th)-(\d+)$/);
    return m ? `https://assets.tcgdex.net/en/me/${m[1]}/${m[2]}/high.webp ${local}` : local;
  }
  // the official gallery CDN only allows its own site to use images in WebGL; 3D shows a labelled card until TCGdex has the art
  if (/\.(png|jpe?g)$/i.test(c.image)) return "";
  return `${c.image}/${size}.webp`;
}

function filmCard(c: Card) {
  const st = statusOf(c.id);
  const m = marketOf(c.id);
  const f = foilFor(c.rarity);
  return {
    id: c.id, name: c.name, number: c.number, rarity: c.rarity, owned: owned(st), status: STATUS_LABEL[st],
    priority: PRIORITY_LABEL[priorityOf(c, entry(c.id))], price: m != null ? formatCAD(m) : undefined,
    tex: texUrl(c, "high"), thumb: texUrl(c, "low"),
    foil: f === "rainbow" || f === "cosmos" ? 1 : f === "gold" ? 0.8 : f === "sparkle" ? 0.6 : 0.25,
  };
}

function home(): Node {
  homeAbort = new AbortController();
  const root = h("div", { class: "film-root" });
  const withImg = SET.cards.filter((c) => c.image);
  const rank: Record<Priority, number> = { chase: 0, high: 1, normal: 2, low: 3 };
  const byValue = (a: Card, b: Card) => rank[priorityOf(a, entry(a.id))] - rank[priorityOf(b, entry(b.id))] || (marketOf(b.id) ?? 0) - (marketOf(a.id) ?? 0);
  const ownedCards = withImg.filter((c) => owned(statusOf(c.id))).sort(byValue);
  const missingCards = withImg.filter((c) => !owned(statusOf(c.id))).sort(byValue);
  const heroCard = ownedCards[0] ?? withImg.sort(byValue)[0];
  const chase = (missingCards.length ? missingCards : ownedCards).slice(0, 8);
  const scanCard = BY_ID.get("092") ?? ownedCards[1] ?? heroCard;
  const own = SET.cards.filter((c) => owned(statusOf(c.id))).length;
  requestAnimationFrame(() => {
    filmCleanup?.();
    filmCleanup = mountFilm(root, {
      setName: SET.name, owned: own, total: SET.cards.length,
      hero: filmCard(heroCard), chase: chase.map(filmCard), page: withImg.slice(0, 9).map(filmCard), scan: filmCard(scanCard),
      wall: withImg.slice(0, 200).map(filmCard),
      links: { binder: "#binder", shelf: "#shelf", scan: "#scan", buy: "#buy", packs: "#packs", grade: "#grade" },
    });
    homeAbort!.signal.addEventListener("abort", () => { filmCleanup?.(); filmCleanup = null; });
  });
  return root;
}

// ---------- Shelf ----------
function setProgress(b: Binder): { have: number; total: number } | null {
  if (b.kind !== "set" || !b.setId) return null;
  const set = b.setId === BUNDLED.id ? BUNDLED : loadCatalog(b.setId)?.set;
  if (!set) return null;
  const c = b.setId === SET.id ? col : load(b.setId);
  return { have: set.cards.filter((x) => owned(c.entries[x.id]?.status)).length, total: set.cards.length };
}

function openBinder(b: Binder) {
  shelf.active = b.id;
  persistShelf();
  if (b.kind === "set" && b.setId && b.setId !== SET.id) void activateSet(b.setId).then(() => { location.hash = "#binder"; render(); });
  else { location.hash = "#binder"; render(); }
}

function shelfView(): Node {
  void ensureGalleries();
  const fresh = newGalleries();
  const banner = fresh.length ? h("div", { class: "reopened new-sets" },
    h("b", {}, fresh.length === 1 ? "New set on the official gallery" : `${fresh.length} new sets on the official gallery`),
    ...fresh.flatMap((g) => g.parts.map((p) => h("button", { class: "btn", onclick: () => { markGalleriesSeen(); addGalleryBinder(g, p); } }, `Start a ${partName(g, p)} binder`))),
    h("button", { class: "btn ghost", onclick: () => { markGalleriesSeen(); render(); } }, "Dismiss")) : null;
  const items = shelf.binders.map((b) => {
    const pr = setProgress(b);
    return h("div", { class: "shelf-item" },
      h("button", { class: "mini-btn", "aria-label": `Open ${b.name}`, onclick: () => openBinder(b) },
        coverEl({ title: b.name, subtitle: b.kind === "set" ? "Set binder" : "Personal", logo: b.logo, color: b.color, material: b.material }, "mini")),
      h("div", { class: "shelf-meta" }, h("b", {}, b.name),
        h("span", {}, pr ? `${pr.have}/${pr.total}` : b.kind === "personal" ? `${b.slots?.length ?? 0} cards` : "")),
      pr ? h("span", { class: "progress-line" }, h("i", { style: `--p:${pr.have / (pr.total || 1)}` })) : null,
      h("button", { class: "linkish edit-link", onclick: () => editBinder(b) }, "Edit"));
  });
  return h("section", { class: "view" },
    masthead({
      kicker: "Your shelf", title: "Your binders.",
      lede: "One binder per set you're collecting, from Base Set to whatever comes out next, plus personal binders for your favourite cards from any set.",
      meta: [["Binders", String(shelf.binders.length)], ["Set binders", String(shelf.binders.filter((x) => x.kind === "set").length)], ["Personal", String(shelf.binders.filter((x) => x.kind === "personal").length)], ["Open now", SET.name]],
      actions: [h("button", { class: "btn", onclick: pickSet }, "Add a set binder"), h("button", { class: "btn ghost", onclick: () => editBinder() }, "New personal binder")],
      scene: { kind: "fan", cards: ownedTop(4).map(stageCard) },
    }),
    banner,
    h("div", { class: "shelf" }, ...items,
      h("button", { class: "new-binder", onclick: pickSet }, h("strong", {}, "+ Set binder"), h("span", {}, "Any set, old or new")),
      h("button", { class: "new-binder", onclick: () => editBinder() }, h("strong", {}, "+ Personal binder"), h("span", {}, "Your own picks"))),
    h("div", { class: "shelf-plank", "aria-hidden": "true" }));
}

function pickSet() {
  const dlg = $("#sheet") as HTMLDialogElement;
  const list = h("div", { class: "set-list" }, h("p", { class: "loading" }, "Loading sets…"));
  const input = h("input", { id: "set-search", type: "search", placeholder: "Search sets, e.g. 151, Evolving Skies, Base Set" }) as HTMLInputElement;
  let data: { sets: SetSummary[]; series: Record<string, string> } | undefined = loadSetList();
  const choose = (id: string, name: string, logo?: string) => {
    const b = addSetBinder(shelf, id, name, logo);
    persistShelf();
    dlg.close();
    openBinder(b);
  };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const rows: Node[] = [];
    if (!q || "30th celebration".includes(q)) rows.push(h("h3", {}, "Bundled"), h("button", { class: "set-row", onclick: () => choose(BUNDLED.id, BUNDLED.name) },
      h("span", { class: "badge" }, "30C"), h("span", {}, h("b", {}, "30th Celebration"), h("br"), h("small", {}, "with Classic Collection, energies and scanner")), h("span", { class: "num" }, String(BUNDLED.cards.length))));
    const official = GALLERIES.galleries.filter((g) => g.slug !== "30th-celebration").flatMap((g) => g.parts.map((p) => ({ g, p, name: partName(g, p) })))
      .filter((x) => !q || x.name.toLowerCase().includes(q) || shortName(x.g.name).toLowerCase().includes(q));
    if (official.length) {
      rows.push(h("h3", {}, "Official card galleries", h("a", { class: "h3-link", href: GALLERIES.source, target: "_blank", rel: "noopener" }, "tcg.pokemon.com")));
      for (const { g, p, name } of official)
        rows.push(h("button", { class: "set-row", onclick: () => { dlg.close(); addGalleryBinder(g, p); } },
          g.logo ? h("img", { src: g.logo, alt: "", loading: "lazy", class: "gal-logo", onerror: (e: Event) => ((e.target as HTMLElement).style.visibility = "hidden") }) : h("span", { class: "badge" }, g.code),
          h("span", {}, h("b", {}, name), isNewGallery(g.firstSeen) ? h("span", { class: "pill-new" }, "New") : "", h("br"),
            h("small", {}, p.tcgdex ? Object.keys(p.categories).map((k) => g.filters[k] ?? k).slice(0, 3).join(" · ") : "Just released: names and prices fill in when the card database adds it")),
          h("span", { class: "num" }, String(p.count))));
    }
    const inGallery = new Set(GALLERIES.galleries.flatMap((g) => g.parts.map((p) => p.tcgdex)).filter(Boolean));
    if (data) {
      const sets = data.sets.filter((x) => !x.id.startsWith("30th") && !inGallery.has(x.id) && (!q || x.name.toLowerCase().includes(q) || x.id.toLowerCase().includes(q)));
      if (sets.length) rows.push(h("h3", {}, "Every other set"));
      const order: string[] = [];
      for (const x of sets) if (!order.includes(x.series)) order.push(x.series);
      for (const sr of order.reverse()) {
        rows.push(h("h4", {}, data.series[sr] ?? (sr === "other" ? "Other" : sr)));
        for (const x of sets.filter((y) => y.series === sr).reverse())
          rows.push(h("button", { class: "set-row", onclick: () => choose(x.id, x.name, x.logo) },
            x.logo ? h("img", { src: x.logo + ".webp", alt: "", loading: "lazy" }) : h("span", { class: "badge" }, x.id),
            h("b", {}, x.name), h("span", { class: "num" }, `${x.official}${x.total > x.official ? `+${x.total - x.official}` : ""}`)));
      }
    }
    list.replaceChildren(...rows);
  };
  input.addEventListener("input", draw);
  dlg.replaceChildren(h("form", { method: "dialog", class: "sheet-inner" },
    h("header", { class: "sheet-head" }, h("div", {}, h("p", { class: "eyebrow" }, "New set binder"), h("h2", {}, "Pick a set")),
      h("button", { class: "close", value: "close", "aria-label": "Close" }, "×")),
    h("div", { class: "sheet-pad" }, input, list)));
  dlg.onclose = () => render();
  dlg.showModal();
  draw();
  if (__ARTIFACT__) { list.append(h("p", { class: "hint" }, "This preview can't reach the card database. In the installed app every set is listed here.")); return; }
  if (!data || Date.now() - (data as { at?: number }).at! > 86400000)
    fetchSetList().then((l) => { saveSetList(l); data = l; draw(); }).catch(() => { if (!data) list.append(h("p", { class: "hint" }, "Couldn't reach the card database. Check your connection and try again.")); });
}

function editBinder(existing?: Binder) {
  const dlg = $("#sheet") as HTMLDialogElement;
  const st = { owner: existing?.owner ?? "", name: existing?.name ?? "", color: existing?.color ?? COVER_COLORS[3], material: existing?.material ?? ("leather" as Material), pockets: existing?.pockets ?? (9 as Pockets) };
  const preview = h("div", { class: "edit-preview" });
  const drawPreview = () => preview.replaceChildren(coverEl({ title: st.name || "My binder", subtitle: existing?.kind === "set" ? "Set binder" : "Personal", logo: existing?.logo, color: st.color, material: st.material }, "mini"));
  const name = h("input", { id: "binder-name", value: st.name, placeholder: "e.g. Eeveelutions, Grails, Umbreon PC", oninput: (e: Event) => { st.name = (e.target as HTMLInputElement).value; drawPreview(); } });
  const seg = <T extends string | number>(label: string, opts: [T, string][], get: () => T, set: (v: T) => void) => {
    const wrap = h("div", { class: "seg", role: "radiogroup", "aria-label": label });
    const draw = () => wrap.replaceChildren(...opts.map(([v, l]) => h("button", { role: "radio", "aria-checked": String(get() === v), onclick: (e: Event) => { e.preventDefault(); set(v); draw(); drawPreview(); } }, l)));
    draw();
    return h("div", { class: "field" }, h("span", {}, label), wrap);
  };
  const swatches = h("div", { class: "swatches", role: "radiogroup", "aria-label": "Colour" });
  const drawSw = () => swatches.replaceChildren(...COVER_COLORS.map((c) => h("button", { class: "swatch", role: "radio", "aria-checked": String(st.color === c), "aria-label": c, style: `background:${c}`,
    onclick: (e: Event) => { e.preventDefault(); st.color = c; drawSw(); drawPreview(); } })));
  drawSw(); drawPreview();
  let armed = false;
  const del = existing && shelf.binders.length > 1 ? h("button", { class: "btn ghost", onclick: (e: Event) => {
    e.preventDefault();
    if (!armed) { armed = true; del!.textContent = existing.kind === "set" ? "Tap again: removes the binder, keeps your card data" : "Tap again to delete this binder"; return; }
    shelf.binders = shelf.binders.filter((x) => x.id !== existing.id);
    if (shelf.active === existing.id) shelf.active = shelf.binders[0].id;
    persistShelf(); dlg.close(); location.hash = "#shelf"; render();
  } }, "Delete binder") : null;
  const saveBtn = h("button", { class: "btn", onclick: (e: Event) => {
    e.preventDefault();
    if (existing) Object.assign(existing, { owner: st.owner.trim() || undefined, name: st.name.trim() || existing.name, color: st.color, material: st.material, pockets: st.pockets });
    else { const b = addPersonalBinder(shelf, st.name, st.color, st.material, st.pockets); b.owner = st.owner.trim() || undefined; shelf.active = b.id; }
    persistShelf(); dlg.close(); location.hash = existing ? location.hash : "#binder"; render();
  } }, existing ? "Save" : "Create binder");
  dlg.replaceChildren(h("form", { method: "dialog", class: "sheet-inner" },
    h("header", { class: "sheet-head" }, h("div", {}, h("p", { class: "eyebrow" }, existing ? "Edit binder" : "New personal binder"), h("h2", {}, existing?.name ?? "Personal binder")),
      h("button", { class: "close", value: "close", "aria-label": "Close" }, "×")),
    h("div", { class: "sheet-body" }, preview,
      h("div", { class: "fields" },
        h("label", { class: "field" }, h("span", {}, "Name"), name),
        h("label", { class: "field" }, h("span", {}, "Property of (written inside the cover)"), h("input", { id: "binder-owner", value: st.owner, placeholder: "Your name", oninput: (e: Event) => { st.owner = (e.target as HTMLInputElement).value; } })),
        h("div", { class: "field" }, h("span", {}, "Cover colour"), swatches),
        seg<Material>("Material", [["leather", "Leather"], ["canvas", "Canvas"], ["carbon", "Carbon"]], () => st.material, (v) => (st.material = v)),
        seg<Pockets>("Pockets per page", [[4, "4"], [9, "9"], [12, "12"]], () => st.pockets, (v) => (st.pockets = v)),
        h("div", { class: "row" }, saveBtn, del)))));
  dlg.onclose = () => render();
  dlg.showModal();
}

function filteredCards() {
  const q = filters.q.trim().toLowerCase();
  return SET.cards.filter((c) => {
    const s = statusOf(c.id);
    if (filters.show === "missing" && !missing(s)) return false;
    if (filters.show === "have" && !owned(s)) return false;
    if ((filters.show === "in-store" || filters.show === "ordered") && s !== filters.show) return false;
    if (filters.group.startsWith("s:") && c.section !== filters.group.slice(2)) return false;
    if (filters.group.startsWith("r:") && c.rarity !== filters.group.slice(2)) return false;
    return !q || c.name.toLowerCase().includes(q) || c.number.toLowerCase().includes(q);
  });
}

function pocket(c: Card) {
  const s = statusOf(c.id);
  const e = entry(c.id);
  const pc = checkPrice(e.priceSeen, marketOf(c.id), col.settings);
  return h("article", { class: `pocket st-${s}` },
    h("button", { class: "open", "aria-label": `${c.name} ${c.number}, ${STATUS_LABEL[s]}. Open details`, onclick: () => openCard(c.id) }, holoCard(c)),
    h("div", { class: "meta" },
      h("span", { class: "num" }, c.number),
      h("span", { class: "nm" }, c.name),
      h("span", { class: "tags" },
        s !== "need" && s !== "have" ? h("span", { class: `badge b-${s}` }, STATUS_LABEL[s]) : null,
        pc.verdict !== "unknown" && missing(s) ? h("span", { class: `badge v-${pc.verdict}` }, VERDICT_LABEL[pc.verdict]) : null,
        (e.qty ?? 1) > 1 && owned(s) ? h("span", { class: "badge" }, `×${e.qty}`) : null)),
    h("button", { class: "tick", "aria-pressed": String(owned(s)), title: owned(s) ? "Mark as needed" : "Mark as owned",
      "aria-label": owned(s) ? `Mark ${c.name} as needed` : `Mark ${c.name} as owned`,
      onclick: () => { updateEntry(col, c.id, { status: owned(s) ? "need" : "have" }); persist(); render(); } }, "✓"));
}

// ---------- Card sheet ----------
function openCard(id: string) {
  const c = BY_ID.get(id)!;
  const dlg = $("#sheet") as HTMLDialogElement;
  const e = entry(id);
  const field = (label: string, input: HTMLElement) => h("label", { class: "field" }, h("span", {}, label), input);
  const numIn = (k: keyof Entry, step = "0.01") => h("input", { id: `f-${k}`, type: "number", inputmode: "decimal", min: "0", step, value: e[k] ?? "",
    onchange: (ev: Event) => { const v = (ev.target as HTMLInputElement).value; updateEntry(col, id, { [k]: v === "" ? undefined : Number(v) }); persist(); refreshVerdict(); } });
  const txtIn = (k: keyof Entry, type = "text") => h("input", { id: `f-${k}`, type, value: (e[k] as string) ?? "",
    onchange: (ev: Event) => { updateEntry(col, id, { [k]: (ev.target as HTMLInputElement).value || undefined }); persist(); } });
  const verdict = h("p", { class: "verdict" });
  function refreshVerdict() {
    const x = entry(id);
    const pc = checkPrice(x.priceSeen, marketOf(id), col.settings);
    verdict.className = `verdict v-${pc.verdict}`;
    verdict.replaceChildren(h("strong", {}, VERDICT_LABEL[pc.verdict]), " ", pc.note);
  }
  refreshVerdict();
  const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Status" },
    ...STATUS_ORDER.map((s) => h("button", { role: "radio", "aria-checked": String((e.status ?? "need") === s), class: `b-${s}`,
      onclick: (ev: Event) => {
        updateEntry(col, id, { status: s, ...(s === "in-store" && !entry(id).seenOn ? { seenOn: new Date().toISOString().slice(0, 10) } : {}) });
        persist();
        seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b === ev.currentTarget)));
      } }, STATUS_LABEL[s])));
  const prio = h("select", { id: "f-priority", onchange: (ev: Event) => { updateEntry(col, id, { priority: (ev.target as HTMLSelectElement).value as Priority }); persist(); } },
    ...(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => h("option", { value: p, selected: priorityOf(c, e) === p }, PRIORITY_LABEL[p])));
  const q = encodeURIComponent(`${c.name} ${c.number} 30th Celebration`);
  dlg.replaceChildren(
    h("form", { method: "dialog", class: "sheet-inner" },
      h("header", { class: "sheet-head" },
        h("div", {}, h("p", { class: "eyebrow" }, `${c.section} · ${c.rarity}`), h("h2", {}, c.name), h("p", { class: "num" }, c.number)),
        h("button", { class: "close", value: "close", "aria-label": "Close" }, "×")),
      h("div", { class: "sheet-body" },
        h("div", { class: "big" }, c.image ? stage({ kind: "single", card: { ...stageCard(c), ghost: false }, drag: true }, "sheet-stage") : holoCard(c, "large", true),
          h("p", { class: "drag-hint" }, "Drag to turn it over"),
          e.grade ? h("p", { class: "graded" }, `Centering ${e.grade.centering} · best ${e.grade.company}`) : null),
        h("div", { class: "fields" },
          seg,
          h("div", { class: "two" }, field("Priority", prio), field("Copies owned", numIn("qty", "1"))),
          h("div", { class: "two" }, field("Store / seller", txtIn("store")), field("Date seen", txtIn("seenOn", "date"))),
          h("div", { class: "two" }, field("Asking price (CAD)", numIn("priceSeen")), field(AUTO[id] != null ? `Market value (TCGplayer ≈ ${formatCAD(AUTO[id])})` : "Market value (CAD)", numIn("market"))),
          verdict,
          h("p", { class: "lookup" }, "Look up market value: ",
            h("a", { href: `https://www.tcgplayer.com/search/pokemon/product?q=${q}`, target: "_blank", rel: "noopener" }, "TCGplayer"), " · ",
            h("a", { href: `https://www.pricecharting.com/search-products?q=${q}&type=prices`, target: "_blank", rel: "noopener" }, "PriceCharting"), " · ",
            h("a", { href: `https://www.ebay.ca/sch/i.html?_nkw=${q}&LH_Sold=1`, target: "_blank", rel: "noopener" }, "eBay sold")),
          h("div", { class: "two" }, field("Paid (CAD)", numIn("paid")), h("div")),
          field("Notes", h("textarea", { id: "f-notes", rows: 2, value: e.notes ?? "",
            onchange: (ev: Event) => { updateEntry(col, id, { notes: (ev.target as HTMLTextAreaElement).value || undefined }); persist(); } })),
          personalTargets(c)))));
  dlg.onclose = () => render();
  dlg.showModal();
}

function personalTargets(c: Card) {
  const ps = shelf.binders.filter((b) => b.kind === "personal");
  const sel = h("select", { id: "f-personal", "aria-label": "Add to a personal binder" }, h("option", { value: "" }, ps.length ? "Choose a personal binder…" : "Create a personal binder…"),
    ...ps.map((b) => h("option", { value: b.id }, b.name)));
  sel.addEventListener("change", () => {
    if (!sel.value) return;
    const b = shelf.binders.find((x) => x.id === sel.value)!;
    addSlot(b, { ref: SET.id === BUNDLED.id ? `${SET.id}/${c.id}` : c.id, setId: SET.id, setName: SET.name, name: c.name, number: c.number, image: c.image });
    persistShelf(); toast(`Added to ${b.name}`); sel.value = "";
  });
  return ps.length ? h("label", { class: "field" }, h("span", {}, "Add to a personal binder"), sel)
    : h("p", { class: "lookup" }, "Keep favourites together: ", h("a", { href: "#shelf" }, "make a personal binder"), ".");
}

// ---------- Scan ----------
interface ScanResult { file: string; preview: string; matches: ReturnType<typeof identify>; done?: string }
let scans: ScanResult[] = [];

function scan(): Node {
  const input = h("input", { id: "scan-file", type: "file", accept: "image/*", capture: "environment", multiple: true, class: "sr-only",
    onchange: (e: Event) => handleScan([...((e.target as HTMLInputElement).files ?? [])]) });
  const drop = h("label", { class: "drop", for: "scan-file" },
    h("strong", {}, "Take or choose card photos"),
    h("span", {}, "One card per photo, on a plain surface, filling most of the frame. You can pick several at once."));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); handleScan([...(e.dataTransfer?.files ?? [])]); });
  const list = h("div", { class: "scans", id: "scans" }, ...scans.map(scanRow));
  const sc = BY_ID.get("092") ?? ownedTop(1)[0];
  return h("section", { class: "view" },
    masthead({
      kicker: `Scanner · ${SET.name}`, title: "Point. Scan. Filed.",
      lede: `Your photo is matched against the ${REFS.length || SET.cards.length} official ${SET.name} card images, right on this device. Nothing is uploaded. Confirm the match and the card is filed.`,
      meta: [["Right first guess", "98.4%"], ["In the top three", "99.6%"], ["Per scan", "≈ 0.2 s"], ["Uploads", "None"]],
      scene: sc ? { kind: "single", card: { ...stageCard(sc), ghost: false }, scan: true } : null,
    }),
    h("div", { class: "narrow-col" }, ...(REFS.length ? [input, drop, list] : [prepareScanner()])));
}

function prepareScanner(): Node {
  const bar = h("span", { class: "progress-line" }, h("i", { style: "--p:0" }));
  const msg = h("p", { class: "hint", role: "status" });
  const btn = h("button", { class: "btn", onclick: async () => {
    btn.setAttribute("disabled", "");
    const cards = SET.cards.filter((c) => c.image);
    const refs: RefFingerprint[] = [];
    let done = 0, failed = 0, next = 0;
    const worker = async () => {
      while (next < cards.length) {
        const c = cards[next++];
        try {
          const blob = await (await fetch(imgUrl(c, "low"))).blob();
          refs.push({ id: c.id, ...fingerprint(canvasToRGBA(await fileToCanvas(blob, 320))) });
        } catch { failed++; }
        done++;
        (bar.firstChild as HTMLElement).style.setProperty("--p", String(done / cards.length));
        msg.textContent = `Learning card ${done} of ${cards.length}…`;
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    REFS = refs;
    try { localStorage.setItem(`setkeeper:v1:fp:${SET.id}`, JSON.stringify(refs)); } catch { /* too big to keep; redo next time */ }
    toast(`Scanner ready for ${SET.name}${failed ? ` (${failed} images missing)` : ""}`);
    render();
  } }, `Get the scanner ready for ${SET.name}`);
  return h("div", { class: "panel" },
    h("h2", {}, "One-time setup for this set"),
    h("p", { class: "hint" }, __ARTIFACT__
      ? "This preview can only scan the 30th Celebration set. The installed app learns any set."
      : `The scanner needs to learn this set's ${SET.cards.filter((c) => c.image).length} card images first. It downloads them once (a few MB) and keeps the fingerprints on this device.`),
    __ARTIFACT__ ? null : btn, bar, msg);
}

async function handleScan(files: File[]) {
  const list = $("#scans");
  for (const f of files.filter((f) => f.type.startsWith("image/"))) {
    const canvas = await fileToCanvas(f, 900);
    const full = canvasToRGBA(canvas);
    // Trim the background around the card when the edges are clear.
    const e = detectEdges(full);
    let x = 0, y = 0, w = canvas.width, hgt = canvas.height;
    const ow = e.outer.right - e.outer.left, oh = e.outer.bottom - e.outer.top;
    if (ow > 0.3 && oh > 0.3 && ow < 0.98 && oh < 0.98) {
      x = Math.round(e.outer.left * canvas.width); y = Math.round(e.outer.top * canvas.height);
      w = Math.round(ow * canvas.width); hgt = Math.round(oh * canvas.height);
    }
    const matches = identify(canvasToRGBA(canvas, x, y, w, hgt), REFS, 4);
    const prev = document.createElement("canvas");
    prev.width = 160; prev.height = Math.round((160 * hgt) / w);
    prev.getContext("2d")!.drawImage(canvas, x, y, w, hgt, 0, 0, prev.width, prev.height);
    const r: ScanResult = { file: f.name, preview: prev.toDataURL("image/jpeg", 0.8), matches };
    scans.unshift(r);
    list?.prepend(scanRow(r));
  }
}

function scanRow(r: ScanResult) {
  const row = h("article", { class: "scan-row" });
  const draw = () => {
    const best = r.matches[0];
    row.replaceChildren(
      h("img", { class: "shot", src: r.preview, alt: `Your photo ${r.file}` }),
      h("div", { class: "cands" },
        h("p", { class: "eyebrow" }, r.done ? r.done : best.confidence > 0.6 ? "Confident match" : "Pick the right card"),
        h("div", { class: "cand-list" }, ...r.matches.slice(0, 3).map((m, i) => {
          const c = BY_ID.get(m.id)!;
          return h("button", { class: "cand" + (i === 0 ? " first" : ""), disabled: !!r.done,
            onclick: () => { updateEntry(col, c.id, { status: "have" }); persist(); r.done = `Marked ${c.name} ${c.number} as owned`; draw(); renderHeader(); toast(r.done); } },
            cardThumb(c, "mini"), h("span", {}, h("b", {}, c.name), h("small", {}, `${c.number} · ${Math.round(m.score * 100)}%`),
              h("small", { class: `st st-${statusOf(c.id)}` }, STATUS_LABEL[statusOf(c.id)])));
        }))));
  };
  draw();
  return row;
}

// ---------- Shop ----------
const shopOpts = { allowOverpriced: false, inStoreOnly: false };

function shop(): Node {
  const s = col.settings;
  const budget = h("input", { id: "budget", type: "number", min: "0", step: "5", value: s.budget, inputmode: "decimal",
    onchange: (e: Event) => { updateSettings(col, { budget: Number((e.target as HTMLInputElement).value) || 0 }); persist(); render(); } });
  const toggle = (k: keyof typeof shopOpts, label: string) => h("label", { class: "check" },
    h("input", { id: `opt-${k}`, type: "checkbox", checked: shopOpts[k], onchange: (e: Event) => { shopOpts[k] = (e.target as HTMLInputElement).checked; render(); } }), label);
  const p = plan(SET.cards, effEntries(), s, { budget: s.budget, ...shopOpts });

  const planList = p.picks.length
    ? h("ol", { class: "plan" }, ...p.picks.map((pk) => h("li", {},
        h("button", { class: "plan-card", onclick: () => openCard(pk.card.id) }, cardThumb(pk.card, "mini")),
        h("div", {}, h("b", {}, `${pk.card.name} `), h("span", { class: "num" }, pk.card.number),
          h("ul", { class: "why" }, ...pk.reasons.map((r) => h("li", {}, r)))),
        h("span", { class: "price" }, formatCAD(pk.cost)))))
    : h("p", { class: "empty" }, p.needPrice.length
        ? "No priced cards fit this budget yet. Add asking prices or market values to the cards you need."
        : "Nothing to buy within this budget.");

  const missingCards = SET.cards.filter((c) => missing(statusOf(c.id)));
  const rank: Record<Priority, number> = { chase: 0, high: 1, normal: 2, low: 3 };
  missingCards.sort((a, b) => rank[priorityOf(a, entry(a.id))] - rank[priorityOf(b, entry(b.id))]
    || Number(statusOf(b.id) === "in-store") - Number(statusOf(a.id) === "in-store"));

  return h("section", { class: "view" },
    masthead({
      kicker: "Budget planner", title: "Spend it where it counts.",
      lede: "Set a budget and SetKeeper picks what to buy first: chase cards, deals, cards in stock near you, and the ones that finish a section.",
      meta: [["Budget", formatCAD(s.budget)], ["Plan total", formatCAD(p.total)], ["Cards", String(p.picks.length)], ["Unpriced", String(p.needPrice.length)]],
      actions: [h("a", { href: "#buy", class: "btn ghost" }, "Best cart across sellers")],
      scene: { kind: "stack", cards: missingTop(4).map((c) => ({ ...stageCard(c), ghost: false })) },
    }),
    h("div", { class: "planner" },
      h("div", { class: "panel" },
        h("label", { class: "field" }, h("span", {}, "Budget (CAD)"), budget),
        toggle("inStoreOnly", "Only cards in stock at a store"),
        toggle("allowOverpriced", "Include overpriced asks"),
        h("div", { class: "total" }, h("span", {}, "Plan total"), h("strong", {}, formatCAD(p.total)), h("small", {}, `of ${formatCAD(p.budget)}`)),
        p.completes.length ? h("p", { class: "completes" }, "Finishes: ", p.completes.join(", ")) : null,
        p.needPrice.length ? h("p", { class: "hint" }, `${p.needPrice.length} missing cards have no price, so they're left out. Open a card to add one.`) : null,
        p.skipped.length ? h("p", { class: "hint" }, `Skipped as overpriced: ${p.skipped.map((x) => x.card.name).slice(0, 4).join(", ")}${p.skipped.length > 4 ? "…" : ""}`) : null),
      h("div", { class: "panel grow" }, h("h2", {}, "Buy these first"), planList)),
    h("h2", {}, `Everything you still need (${missingCards.length})`),
    h("div", { class: "table-wrap" }, h("table", { class: "list" },
      h("thead", {}, h("tr", {}, ...["Card", "Priority", "Status", "Where", "Asking", "Market", "Check"].map((t) => h("th", {}, t)))),
      h("tbody", {}, ...missingCards.map((c) => {
        const e = entry(c.id), pc = checkPrice(e.priceSeen, marketOf(c.id), col.settings);
        return h("tr", { onclick: () => openCard(c.id), tabindex: 0, onkeydown: (ev: KeyboardEvent) => ev.key === "Enter" && openCard(c.id) },
          h("td", {}, h("b", {}, c.name), " ", h("span", { class: "num" }, c.number)),
          h("td", {}, PRIORITY_LABEL[priorityOf(c, e)]),
          h("td", {}, h("span", { class: `badge b-${statusOf(c.id)}` }, STATUS_LABEL[statusOf(c.id)])),
          h("td", {}, [e.store, e.seenOn].filter(Boolean).join(" · ") || "—"),
          h("td", { class: "n" }, formatCAD(e.priceSeen)), h("td", { class: "n" }, formatCAD(marketOf(c.id))),
          h("td", {}, pc.verdict === "unknown" ? "—" : h("span", { class: `badge v-${pc.verdict}` }, VERDICT_LABEL[pc.verdict])));
      })))),
    priceChecker());
}

function priceChecker() {
  const out = h("p", { class: "verdict v-unknown" }, "Enter both prices.");
  const ask = h("input", { id: "pc-ask", type: "number", min: "0", step: "0.01", inputmode: "decimal" });
  const mkt = h("input", { id: "pc-mkt", type: "number", min: "0", step: "0.01", inputmode: "decimal" });
  const usd = h("input", { id: "pc-usd", type: "checkbox" });
  const run = () => {
    const a = Number(ask.value), m = Number(mkt.value) * (usd.checked ? col.settings.usdToCad : 1);
    if (!ask.value || !mkt.value) return;
    const pc = checkPrice(a, m, col.settings);
    out.className = `verdict v-${pc.verdict}`;
    out.replaceChildren(h("strong", {}, VERDICT_LABEL[pc.verdict]), " ", pc.note);
  };
  [ask, mkt, usd].forEach((i) => i.addEventListener("input", run));
  return h("div", { class: "panel checker" },
    h("h2", {}, "Quick price check"),
    h("p", { class: "hint" }, "For anything on a shelf: singles, packs or boxes. Compare the asking price with MSRP or market value."),
    h("div", { class: "two" }, h("label", { class: "field" }, h("span", {}, "Asking (CAD)"), ask), h("label", { class: "field" }, h("span", {}, "Market or MSRP"), mkt)),
    h("label", { class: "check" }, usd, `Market value is in USD (× ${col.settings.usdToCad})`), out);
}

// ---------- Grade (centering) ----------
let gradeState: { canvas: HTMLCanvasElement; edges: Edges } | null = null;

let gradeCard = "";

function grade(): Node {
  void ensureServices();
  const input = h("input", { id: "grade-file", type: "file", accept: "image/*", capture: "environment", class: "sr-only",
    onchange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      const canvas = await fileToCanvas(f, 1400);
      gradeState = { canvas, edges: detectEdges(canvasToRGBA(canvas)) };
      render();
    } });
  const centering = h("div", { class: "panel" },
    h("h2", {}, "Centering check"),
    h("p", { class: "hint" }, "Photograph the front of one card straight on, on a dark or plain surface. The guides snap to the card edge and the inner frame; drag any guide to fine-tune it."),
    input,
    h("label", { class: "drop", for: "grade-file" }, h("strong", {}, gradeState ? "Use another photo" : "Take or choose a photo"),
      h("span", {}, "Works best with the card flat, filling most of the photo, no sleeve glare.")));
  if (gradeState) centering.append(gradeTool(gradeState));
  const gc = BY_ID.get(gradeCard) ?? ownedTop(1)[0];
  return h("section", { class: "view" },
    masthead({
      kicker: "Grading", title: "Centering, measured.",
      lede: "PSA, Beckett, CGC and TAG side by side: which tiers are open today, what they cost, and which company is worth it for each card.",
      meta: (() => {
        const all = SERVICES.companies.flatMap((co) => co.tiers.map((t) => ({ co, t })));
        const open = all.filter((x) => isOpen(x.t));
        const cheap = open.sort((a, b) => a.t.price! - b.t.price!)[0];
        return [["Companies", SERVICES.companies.map((co) => co.name).join(", ")], ["Tiers open", `${open.length} of ${all.length}`],
          ["Cheapest open", cheap ? `${cheap.co.name} ${cheap.t.name} ${usd(cheap.t.price!)}` : "—"], ["Checked", shortDate(SERVICES.checkedAt)]] as [string, string][];
      })(),
      scene: gc ? { kind: "single", card: { ...stageCard(gc), ghost: false }, drag: true } : null,
    }),
    servicesPanel(), worthPanel(), centering, gradingQueue());
}

function capFrom(e: Entry): string | undefined {
  return e.grade?.company?.match(/PSA\s*(\d+)/)?.[1];
}

// ---------- grading services (PSA, Beckett, CGC, TAG) ----------
let SERVICES = servicesData as unknown as ServicesFile;
let servicesTried = false;
async function ensureServices() {
  if (servicesTried || __ARTIFACT__) return;
  servicesTried = true;
  try {
    const res = await fetch("grading/services.json", { cache: "no-cache" });
    if (!res.ok) return;
    const fresh = (await res.json()) as ServicesFile;
    if (fresh.companies?.length && fresh.checkedAt >= SERVICES.checkedAt) { SERVICES = fresh; if (currentView() === "grade") render(); }
  } catch { /* use the bundled copy */ }
}
// ---------- official galleries: new sets ----------
let galleriesTried = false;
async function ensureGalleries() {
  if (galleriesTried || __ARTIFACT__) return;
  galleriesTried = true;
  try {
    const res = await fetch("galleries/index.json", { cache: "no-cache" });
    if (!res.ok) return;
    const fresh = (await res.json()) as GalleryIndex;
    if (fresh.galleries?.length && fresh.checkedAt >= GALLERIES.checkedAt) { GALLERIES = fresh; if (currentView() === "shelf") render(); }
  } catch { /* use the bundled copy */ }
}
const GSEEN_KEY = "setkeeper:v1:galleries-seen";
/** Galleries the collector hasn't been told about yet. The first visit marks everything as seen. */
function newGalleries() {
  let seen: string[] | null = null;
  try { seen = JSON.parse(localStorage.getItem(GSEEN_KEY) ?? "null"); } catch { /* ignore */ }
  if (!seen) { markGalleriesSeen(); return []; }
  return GALLERIES.galleries.filter((g) => !seen!.includes(g.slug));
}
function markGalleriesSeen() { try { localStorage.setItem(GSEEN_KEY, JSON.stringify(GALLERIES.galleries.map((g) => g.slug))); } catch { /* ignore */ } }
/** Found by the daily scout after the first scrape, within the last 45 days. */
const isNewGallery = (firstSeen: string) => {
  const base = GALLERIES.galleries.reduce((m, g) => (g.firstSeen < m ? g.firstSeen : m), "9999");
  return firstSeen > base && Date.now() - Date.parse(firstSeen + "T12:00:00") < 45 * 86400000;
};
function addGalleryBinder(g: GalleryIndex["galleries"][number], p: GalleryIndex["galleries"][number]["parts"][number]) {
  const id = p.tcgdex ?? gallerySetId(g, p);
  const existing = shelf.binders.find((b) => b.setId === id);
  if (existing) { openBinder(existing); return; }
  const b = addSetBinder(shelf, id, partName(g, p), p.tcgdex ? `https://assets.tcgdex.net/en/${g.assetPath.startsWith("me") ? "me" : "sv"}/${p.tcgdex}/logo` : undefined);
  persistShelf();
  openBinder(b);
}

const SEEN_KEY = "setkeeper:v1:tiers-seen";
function seenTiers(): Record<string, TierStatus> { try { return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}"); } catch { return {}; } }
function rememberTiers() {
  const m: Record<string, TierStatus> = {};
  for (const c of SERVICES.companies) for (const t of c.tiers) m[`${c.id}:${t.name}`] = t.status;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}
const usd = (n: number) => `US$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const shortDate = (d?: string) => (d ? new Date(d + "T12:00:00").toLocaleDateString("en-CA", { month: "short", day: "numeric" }) : "");

function slabValues(e: Entry): Record<string, [number | undefined, number | undefined]> {
  const g = e.graded ?? {};
  return { ...(g.values ?? {}), psa: g.values?.psa ?? [g.psa10, g.psa9] };
}

function companyResults(id: string) {
  const e = entry(id), raw = marketOf(id);
  if (raw == null) return [];
  return compareCompanies(SERVICES.companies, { raw, condition: e.graded?.condition ?? "pristine", worst: worstFrom(e.grade?.centering), values: slabValues(e) },
    col.settings.usdToCad, col.settings.gradingShip);
}
function bestResult(id: string) {
  return companyResults(id).filter((x) => x.result).sort((a, b) => b.result!.profit - a.result!.profit)[0];
}
function gradingFor(id: string) { return bestResult(id)?.result; }

const VERDICT: Record<string, string> = { grade: "Grade it", borderline: "Borderline", "keep-raw": "Keep it raw" };

function worthPanel(): Node {
  const ownedCards = SET.cards.filter((c) => owned(statusOf(c.id)) && c.rarity !== "Energy");
  if (!ownedCards.length) return h("div", { class: "panel" }, h("h2", {}, "Worth grading?"), h("p", { class: "hint" }, "Mark cards as owned to check whether they're worth grading."));
  if (!ownedCards.some((c) => c.id === gradeCard)) {
    const rank = ["Futuristic Rare", "RGB Mew", "Special Art ex", "Classic", "Special Art Rare"];
    gradeCard = [...ownedCards].sort((a, b) => (rank.indexOf(a.rarity) + 99) % 99 - (rank.indexOf(b.rarity) + 99) % 99 || (entry(b.id).market ?? 0) - (entry(a.id).market ?? 0))[0].id;
  }
  const c = BY_ID.get(gradeCard)!;
  const e = entry(c.id), g = e.graded ?? {};
  const out = h("div", { class: "worth-out" });
  const setG = (patch: Partial<NonNullable<Entry["graded"]>>) => { updateEntry(col, c.id, { graded: { ...entry(c.id).graded, ...patch } }); persist(); draw(); };
  const setVal = (cid: string, i: 0 | 1, v: number | undefined) => {
    const vals = { ...slabValues(entry(c.id)) };
    const pair: [number | undefined, number | undefined] = [...(vals[cid] ?? [undefined, undefined])] as [number | undefined, number | undefined];
    pair[i] = v; vals[cid] = pair;
    setG({ values: vals, ...(cid === "psa" ? (i === 0 ? { psa10: v } : { psa9: v }) : {}) });
  };
  const num = (id: string, val: number | undefined, on: (v: number | undefined) => void, label: string) =>
    h("input", { id, type: "number", min: "0", step: "0.01", inputmode: "decimal", value: val ?? "", placeholder: "CAD", "aria-label": label,
      onchange: (ev: Event) => { const v = (ev.target as HTMLInputElement).value; on(v === "" ? undefined : Number(v)); } });
  const vals = slabValues(e);
  const q = (co: string) => encodeURIComponent(`${c.name} ${c.number} ${SET.name} ${co}`);
  const slabRows = SERVICES.companies.map((co) => h("tr", {},
    h("th", { scope: "row" }, co.name),
    h("td", {}, h("label", { class: "inline" }, h("span", {}, `${co.name} ${co.grades[0]}`), num(`w-${co.id}-0`, vals[co.id]?.[0], (v) => setVal(co.id, 0, v), `${co.name} ${co.grades[0]} sells for`))),
    h("td", {}, h("label", { class: "inline" }, h("span", {}, `${co.name} ${co.grades[1]}`), num(`w-${co.id}-1`, vals[co.id]?.[1], (v) => setVal(co.id, 1, v), `${co.name} ${co.grades[1]} sells for`))),
    h("td", {}, h("a", { href: `https://www.ebay.ca/sch/i.html?_nkw=${q(co.name)}&LH_Sold=1`, target: "_blank", rel: "noopener" }, "Sold"))));

  function draw() {
    const rs = companyResults(c.id);
    if (!rs.length) { out.replaceChildren(h("p", { class: "hint" }, "Enter the card's raw value to compare grading companies.")); return; }
    const priced = rs.filter((x) => x.result).sort((a, b) => b.result!.profit - a.result!.profit);
    const best = priced[0];
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const rows = rs.map((x) => h("tr", { class: x === best ? "best" : "" },
      h("th", { scope: "row" }, x.company.name),
      h("td", {}, x.tier ? h("span", {}, h("b", {}, x.tier.name), h("small", {}, ` ${usd(x.tier.price!)} · ${x.tier.days ?? "?"} days`)) : h("span", { class: "dim" }, "No open tier covers this card")),
      h("td", { class: "n" }, x.feeCAD != null ? formatCAD(x.feeCAD + col.settings.gradingShip) : "—"),
      h("td", { class: "n" }, x.result ? `${Math.round(x.result.odds[0] * 100)}%` : "—"),
      h("td", { class: `n ${x.result ? (x.result.profit >= 0 ? "pos" : "neg") : ""}` }, x.result ? `${x.result.profit >= 0 ? "+" : ""}${formatCAD(x.result.profit)}` : "add slab prices")));
    out.replaceChildren(
      best ? h("div", { class: `verdict-big vb-${best.result!.verdict}` },
        h("strong", {}, best.result!.verdict === "keep-raw" ? "Keep it raw" : `${VERDICT[best.result!.verdict]} with ${best.company.name}`),
        h("span", {}, best.result!.verdict === "keep-raw" ? best.result!.reason : `${best.tier!.name} tier, ${usd(best.tier!.price!)}, about ${best.tier!.days} business days. ${best.result!.reason}`))
        : h("p", { class: "hint" }, "Add what slabs of this card sell for at one or more companies to see which is worth it."),
      h("div", { class: "table-wrap" }, h("table", { class: "list compare" },
        h("thead", {}, h("tr", {}, ...["Company", "Cheapest open tier", "Fee + shipping", "Top grade chance", "vs selling raw"].map((t) => h("th", {}, t)))),
        h("tbody", {}, ...rows))),
      best ? h("div", { class: "odds" }, ...([[`${best.company.name} ${best.company.grades[0]}`, best.result!.odds[0]], [`${best.company.name} ${best.company.grades[1]}`, best.result!.odds[1]], ["Lower", best.result!.odds[2]]] as [string, number][]).map(([l, p]) =>
        h("div", { class: "odd" }, h("span", {}, l), h("span", { class: "bar", style: `--p:${p}` }), h("b", {}, pct(p))))) : "");
  }
  draw();
  const worst = worstFrom(e.grade?.centering);
  return h("div", { class: "panel worth" },
    h("h2", {}, "Worth grading?"),
    h("div", { class: "worth-grid" },
      h("div", { class: "worth-card" }, holoCard(c, "", true),
        h("select", { id: "worth-card", "aria-label": "Card", onchange: (ev: Event) => { gradeCard = (ev.target as HTMLSelectElement).value; render(); } },
          ...ownedCards.map((x) => h("option", { value: x.id, selected: x.id === c.id }, `${x.name} ${x.number}`)))),
      h("div", { class: "fields" },
        h("div", { class: "field" }, h("span", {}, "How does it look up close?"),
          h("div", { class: "seg", role: "radiogroup", "aria-label": "Condition" }, ...(Object.keys(CONDITION_LABEL) as Condition[]).map((k) =>
            h("button", { role: "radio", "aria-checked": String((g.condition ?? "pristine") === k), onclick: () => { setG({ condition: k }); render(); } }, CONDITION_LABEL[k])))),
        h("p", { class: "hint" }, worst != null ? `Centering measured: ${e.grade!.centering}. Companies that need ${SERVICES.companies[0].centering[0]}/${100 - SERVICES.companies[0].centering[0]} or better for their top grade are capped accordingly.` : "Centering not measured yet; use the check below and save it to this card for a sharper answer."),
        h("label", { class: "field" }, h("span", {}, "Raw value (CAD)"), num("w-raw", marketOf(c.id), (v) => { updateEntry(col, c.id, { market: v }); persist(); draw(); }, "Raw value")),
        h("div", { class: "table-wrap" }, h("table", { class: "list slabs" },
          h("thead", {}, h("tr", {}, h("th", {}, "Slab prices (CAD)"), h("th", {}, "Top grade"), h("th", {}, "Next grade"), h("th", {}, ""))),
          h("tbody", {}, ...slabRows))),
        out,
        h("p", { class: "fine" }, `Fees are each company's cheapest open tier that covers the card's value, converted at ${col.settings.usdToCad} CAD per USD, plus ${formatCAD(col.settings.gradingShip)} shipping and insurance per card (change on Data). Grade chances are rough starting points.`))));
}

function servicesPanel(): Node {
  const seen = seenTiers();
  const reopened = Object.keys(seen).length ? reopenedSince(SERVICES.companies, seen) : [];
  const fx = col.settings.usdToCad;
  const panel = h("div", { class: "panel services" },
    h("h2", {}, "Where to grade"),
    reopened.length ? h("div", { class: "reopened", role: "status" }, h("strong", {}, "Just reopened"),
      ...reopened.map(({ company, tier }) => h("span", {}, `${company.name} ${tier.name}, ${usd(tier.price!)}${tier.since ? ` (since ${shortDate(tier.since)})` : ""}`))) : null,
    h("div", { class: "companies" }, ...SERVICES.companies.map((co) => h("section", { class: "company" },
      h("header", {}, h("h3", {}, co.name), h("a", { href: co.url, target: "_blank", rel: "noopener" }, "Submit"),
        h("p", { class: "fine" }, `Checked ${shortDate(co.checkedAt)} · `, h("a", { href: co.source, target: "_blank", rel: "noopener" }, "source"))),
      h("ul", { class: "tiers" }, ...co.tiers.map((t) => {
        const isNew = reopened.some((r) => r.company === co && r.tier === t);
        return h("li", { class: `tier t-${t.status}${isNew ? " is-new" : ""}`, title: t.note ?? "" },
          h("span", { class: "t-name" }, t.name),
          h("span", { class: "t-price" }, t.price != null ? usd(t.price) : "—", t.price != null ? h("small", {}, ` ≈ ${formatCAD(t.price * fx)}`) : null),
          h("span", { class: "t-meta" }, [t.maxValue != null ? `up to ${usd(t.maxValue)}` : "", t.days ? `${t.days} days` : "", t.min ? `min ${t.min}` : ""].filter(Boolean).join(" · ")),
          h("span", { class: `t-status s-${t.status}` }, isNew ? "Reopened" : TIER_LABEL[t.status]),
          t.note && t.status !== "open" ? h("span", { class: "t-note" }, t.note) : null);
      }))))),
    h("p", { class: "fine" }, SERVICES.note));
  rememberTiers();
  return panel;
}

function gradingQueue(): Node {
  const rows = SET.cards.filter((c) => owned(statusOf(c.id))).map((c) => ({ c, b: bestResult(c.id) })).filter((x) => x.b) as { c: Card; b: NonNullable<ReturnType<typeof bestResult>> }[];
  rows.sort((a, b) => b.b.result!.profit - a.b.result!.profit);
  return h("div", { class: "panel" }, h("h2", {}, "Grading queue"),
    rows.length ? h("div", { class: "table-wrap" }, h("table", { class: "list" },
      h("thead", {}, h("tr", {}, ...["Card", "Best company", "Chance of top grade", "vs raw", "Verdict"].map((t) => h("th", {}, t)))),
      h("tbody", {}, ...rows.map(({ c, b }) => h("tr", { onclick: () => { gradeCard = c.id; render(); scrollTo({ top: 0, behavior: "smooth" }); } },
        h("td", {}, h("b", {}, c.name), " ", h("span", { class: "num" }, c.number)),
        h("td", {}, `${b.company.name} ${b.tier!.name}`),
        h("td", { class: "n" }, `${Math.round(b.result!.odds[0] * 100)}%`),
        h("td", { class: `n ${b.result!.profit >= 0 ? "pos" : "neg"}` }, `${b.result!.profit >= 0 ? "+" : ""}${formatCAD(b.result!.profit)}`),
        h("td", {}, h("span", { class: `badge vbb-${b.result!.verdict}` }, VERDICT[b.result!.verdict]))))))) 
      : h("p", { class: "hint" }, "Cards you price above show up here, best grading candidates first."));
}

function gradeTool(st: { canvas: HTMLCanvasElement; edges: Edges }) {
  const { canvas } = st;
  const view = h("canvas", { class: "grade-canvas", width: canvas.width, height: canvas.height });
  const ctx = view.getContext("2d")!;
  const readout = h("div", { class: "readout" });
  const sides = ["left", "right", "top", "bottom"] as const;
  type Guide = { ring: "outer" | "inner"; side: (typeof sides)[number] };
  const guides: Guide[] = [];
  for (const ring of ["outer", "inner"] as const) for (const side of sides) guides.push({ ring, side });
  const pos = (g: Guide) => st.edges[g.ring][g.side];
  const isX = (g: Guide) => g.side === "left" || g.side === "right";

  function draw() {
    ctx.drawImage(canvas, 0, 0);
    ctx.lineWidth = Math.max(2, canvas.width / 400);
    for (const g of guides) {
      ctx.strokeStyle = g.ring === "outer" ? "#2ec4b6" : "#ff9f1c";
      ctx.setLineDash(g.ring === "inner" ? [10, 6] : []);
      ctx.beginPath();
      if (isX(g)) { const x = pos(g) * canvas.width; ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); }
      else { const y = pos(g) * canvas.height; ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); }
      ctx.stroke();
    }
    const c = centeringFrom(st.edges);
    readout.replaceChildren(
      h("div", { class: "ratio" }, h("span", {}, "Left / Right"), h("strong", {}, `${c.leftRight[0]} / ${c.leftRight[1]}`)),
      h("div", { class: "ratio" }, h("span", {}, "Top / Bottom"), h("strong", {}, `${c.topBottom[0]} / ${c.topBottom[1]}`)),
      h("div", { class: "caps" },
        h("span", {}, "PSA ", h("b", {}, c.psa)), h("span", {}, "BGS ", h("b", {}, c.bgs)), h("span", {}, "CGC ", h("b", {}, c.cgc))),
      h("p", { class: "hint" }, st.edges.confidence < 0.5
        ? "The guides weren't sure about this photo. Check that the solid lines sit on the card edge and the dashed lines on the inner frame."
        : "Best grade centering alone allows (front only). Corners, edges and surface still count."),
      saveGrade(c));
  }
  let drag: Guide | null = null;
  const toLocal = (e: PointerEvent) => {
    const r = view.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, w: r.width, h: r.height };
  };
  view.addEventListener("pointerdown", (e) => {
    const p = toLocal(e);
    let best: Guide | null = null, bd = Infinity;
    for (const g of guides) {
      const d = isX(g) ? Math.abs(pos(g) - p.x) * p.w : Math.abs(pos(g) - p.y) * p.h;
      if (d < bd) { bd = d; best = g; }
    }
    if (best && bd < 28) { drag = best; view.setPointerCapture(e.pointerId); }
  });
  view.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = toLocal(e);
    st.edges[drag.ring][drag.side] = Math.max(0, Math.min(1, isX(drag) ? p.x : p.y));
    draw();
  });
  view.addEventListener("pointerup", () => (drag = null));
  draw();
  return h("div", { class: "grade" }, h("div", { class: "grade-stage" }, view), readout);
}

function saveGrade(c: ReturnType<typeof centeringFrom>) {
  const sel = h("select", { id: "grade-card", "aria-label": "Card" }, h("option", { value: "" }, "Save to a card…"),
    ...SET.cards.filter((x) => owned(statusOf(x.id))).map((x) => h("option", { value: x.id }, `${x.name} ${x.number}`)));
  return h("div", { class: "row" }, sel, h("button", { class: "btn", onclick: () => {
    if (!sel.value) return toast("Choose the card first.");
    updateEntry(col, sel.value, { grade: { company: `PSA ${c.psa}`, centering: `${c.leftRight.join("/")} L/R, ${c.topBottom.join("/")} T/B`, measuredOn: new Date().toISOString().slice(0, 10) } });
    persist(); toast("Saved centering to the card.");
  } }, "Save"));
}

// ---------- Stats ----------
function stats(): Node {
  const own = SET.cards.filter((c) => owned(statusOf(c.id))).length;
  const spent = Object.values(col.entries).reduce((a, e) => a + (e.paid ?? 0), 0);
  const miss = SET.cards.filter((c) => missing(statusOf(c.id)));
  const eff = effEntries();
  const finish = miss.reduce((a, c) => a + (estimatedCost(eff[c.id]) ?? 0), 0);
  const unpriced = miss.filter((c) => estimatedCost(eff[c.id]) == null).length;
  const spares = SET.cards.filter((c) => owned(statusOf(c.id)) && (entry(c.id).qty ?? 1) > 1);
  const tile = (label: string, value: string, sub?: string) => h("div", { class: "tile" }, h("span", {}, label), h("strong", {}, value), sub ? h("small", {}, sub) : null);
  const bars = (kind: "section" | "rarity") => h("div", { class: "bars" }, ...progress(SET.cards, effEntries(), kind).map((g) =>
    h("div", { class: "bar-row" },
      h("span", { class: "lbl" }, g.label),
      h("span", { class: "bar", style: `--p:${g.owned / g.total}`, role: "img", "aria-label": `${g.owned} of ${g.total}` }),
      h("span", { class: "n" }, `${g.owned}/${g.total}`),
      h("span", { class: "n dim" }, g.missing.length === 0 ? "Done" : g.costToFinish != null ? formatCAD(g.costToFinish) : "needs prices"))));
  return h("section", { class: "view" },
    masthead({
      kicker: `${SET.name} · stats`, title: `${own} of ${SET.cards.length}.`,
      lede: "Where your set stands: by section, by rarity, what's left to spend, and the spares you could trade.",
      scene: { kind: "grid", cards: SET.cards.filter((c) => c.image).slice(0, 30).map(stageCard) },
    }),
    h("div", { class: "tiles" },
      tile("Owned", `${own}`, `of ${SET.cards.length}`),
      tile("Complete", `${Math.round((100 * own) / SET.cards.length)}%`),
      tile("Still need", `${miss.length}`, `${SET.cards.filter((c) => statusOf(c.id) === "in-store").length} in store now`),
      tile("Spent", formatCAD(spent)),
      tile("To finish", formatCAD(finish), unpriced ? `+ ${unpriced} unpriced` : "all priced")),
    (col.badges ?? []).length ? h("div", { class: "badges" }, ...(col.badges ?? []).map((b) => h("span", { class: "medal", title: `Completed ${b.date}` }, h("i", { "aria-hidden": "true" }), b.label))) : null,
    h("div", { class: "panel" }, h("h2", {}, "What stands out"), h("ul", { class: "insights" }, ...insights(SET.cards, effEntries(), col.settings).map((t) => h("li", {}, t)))),
    h("div", { class: "cols" },
      h("div", { class: "panel" }, h("h2", {}, "By section"), bars("section")),
      h("div", { class: "panel" }, h("h2", {}, "By rarity"), bars("rarity"))),
    h("div", { class: "panel" }, (() => { const n = spares.reduce((a, c) => a + (entry(c.id).qty ?? 1) - 1, 0); return h("h2", {}, `Trade binder (${n} spare${n === 1 ? "" : "s"})`); })(),
      spares.length ? h("ul", { class: "spares" }, ...spares.map((c) => h("li", {}, h("b", {}, `${c.name} `), h("span", { class: "num" }, c.number), ` · ${(entry(c.id).qty ?? 1) - 1} spare`)))
        : h("p", { class: "hint" }, "Cards with more than one copy show up here.")));
}

// ---------- Data ----------
function data(): Node {
  const s = col.settings;
  const msg = h("p", { class: "hint", id: "import-msg", role: "status" });
  const file = h("input", { id: "import-file", type: "file", accept: ".xlsx,.csv,.json", class: "sr-only",
    onchange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      try {
        const r = await importFile(SET, f.name, await f.arrayBuffer());
        col.entries = { ...col.entries, ...r.entries };
        persist(true);
        msg.textContent = `Imported ${r.matched} cards from ${r.source}${r.unmatched.length ? `; ${r.unmatched.length} rows didn't match a card` : ""}.`;
        renderHeader();
      } catch (err) {
        msg.textContent = (err as Error).message;
      }
    } });
  const csv = exportCSV(SET, col);
  const json = JSON.stringify(col);
  const copy = (text: string, what: string) => async () => {
    try { await navigator.clipboard.writeText(text); toast(`${what} copied`); }
    catch { const ta = $("#export-text") as HTMLTextAreaElement; ta.value = text; ta.hidden = false; ta.select(); toast("Select all and copy"); }
  };
  const download = (text: string, name: string, type: string) => () => {
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const num = (k: keyof typeof s, label: string, step: string, pct = false) =>
    h("label", { class: "field" }, h("span", {}, label),
      h("input", { id: `s-${k}`, type: "number", step, min: "0", value: pct ? Math.round((s[k] as number) * 100) : s[k],
        onchange: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); updateSettings(col, { [k]: pct ? v / 100 : v }); persist(); } }));
  return h("section", { class: "view" },
    masthead({
      kicker: "Data", title: "Your data, your device.",
      lede: "Bring in your spreadsheet, export to Google Sheets, load seller prices, and set the rules SetKeeper uses to judge a price.",
      meta: [["Cards tracked", String(Object.keys(col.entries).length)], ["Stored", syncState.email ? "This browser + cloud" : "This browser"], ["Account", syncState.email ? "Signed in" : "None needed"], ["Last saved", new Date(col.updatedAt).toLocaleDateString("en-CA", { month: "short", day: "numeric" })]],
      scene: null,
    }),
    syncPanel(download),
    h("div", { class: "panel" }, h("h2", {}, "Import"),
      h("p", { class: "hint" }, "Bring in your tracker spreadsheet (.xlsx or a CSV from Google Sheets) or a SetKeeper backup. Cards are matched by section and card number; imported values replace what's here for those cards."),
      file, h("label", { class: "btn", for: "import-file" }, "Choose file"), msg),
    marketPanel(),
    h("div", { class: "panel" }, h("h2", {}, "Export"),
      h("p", { class: "hint" }, "CSV opens in Google Sheets (File → Import) with image links. JSON is a full backup you can import later or on another device."),
      h("div", { class: "row" },
        __ARTIFACT__ ? h("button", { class: "btn", onclick: copy(csv, "CSV") }, "Copy CSV") : h("button", { class: "btn", onclick: download(csv, "30th-celebration.csv", "text/csv") }, "Download CSV"),
        __ARTIFACT__ ? h("button", { class: "btn ghost", onclick: copy(json, "Backup") }, "Copy backup") : h("button", { class: "btn ghost", onclick: download(json, "setkeeper-backup.json", "application/json") }, "Download backup")),
      h("textarea", { id: "export-text", rows: 6, hidden: true, readonly: true, "aria-label": "Export text" })),
    h("div", { class: "panel" }, h("h2", {}, "Price rules"),
      h("div", { class: "two" }, num("dealBelow", "Deal at or under (% of market)", "1", true), num("overAbove", "Overpriced above (%)", "1", true)),
      h("div", { class: "two" }, num("scalperAbove", "Scalper price above (%)", "1", true), num("usdToCad", "USD → CAD rate", "0.01"))),
    h("div", { class: "panel" }, h("h2", {}, "Grading costs"),
      h("div", { class: "two" }, num("gradingFee", "Grading fee per card (CAD)", "0.01"), num("gradingShip", "Shipping + insurance per card (CAD)", "0.01"))),
    h("p", { class: "fine" }, `Card list and images: ${SET.sources[0]}. Unofficial fan tool, not affiliated with The Pokémon Company. Your data stays in this browser.`));
}

// ---------- Buy (cart optimizer across sellers) ----------
let market: MarketState = loadMarket(SET.id);
let scoutTried = false;

async function ensureMarket() {
  if (market.snapshot || scoutTried || __ARTIFACT__) return;
  scoutTried = true;
  try {
    const res = await fetch(`listings/${SET.id}.json`, { cache: "no-cache" });
    if (res.ok) {
      const snap = (await res.json()) as MarketSnapshot;
      if (snap.listings?.length) { market = { ...market, source: "scout", snapshot: snap }; if (currentView() === "buy") render(); }
    }
  } catch { /* no scout data published */ }
}

function useSample() {
  market = { ...market, source: "sample", snapshot: sampleMarket as unknown as MarketSnapshot };
  saveMarket(SET.id, market);
  render();
}

function wantsFor(scope: "all" | "priority"): Want[] {
  return SET.cards
    .filter((c) => missing(statusOf(c.id)) && c.section !== "Basic Energy")
    .filter((c) => scope === "all" || ["chase", "high"].includes(priorityOf(c, entry(c.id))))
    .map((c) => ({ cardId: c.id, label: `${c.name} ${c.number}`, priority: priorityOf(c, entry(c.id)), market: marketOf(c.id) }));
}

function buy(): Node {
  void ensureMarket();
  const snap = withOverrides(market);
  const wrap = h("section", { class: "view" }, masthead({
    kicker: "Buy", title: "The cheapest way to finish.",
    lede: "Every shop's in-stock singles, split across sellers so shipping doesn't eat the savings. Cheap cards that would cost more to ship than they're worth wait for a better order.",
    meta: [["Missing", String(SET.cards.filter((c) => missing(statusOf(c.id)) && c.section !== "Basic Energy").length)], ["Sellers", String(snap?.sellers.length ?? 0)], ["Listings", String(snap?.listings.length ?? 0)], ["Prices in", "CAD"]],
    actions: [h("a", { href: "#shop", class: "btn ghost" }, "Budget planner")],
    scene: { kind: "stack", cards: missingTop(4).map((c) => ({ ...stageCard(c), ghost: false })) },
  }));
  if (!snap) {
    wrap.append(
      h("div", { class: "panel" },
        h("h2", {}, "Add price data"),
        h("p", { class: "hint" }, __ARTIFACT__
          ? "Import a listings sheet (Seller, Card #, Price, Qty, Condition, Shipping, Free over) on the Data tab, or try it with sample data."
          : "Run the price scout (see README) to pull listings from your shops and eBay, import a listings sheet on the Data tab, or try it with sample data."),
        h("div", { class: "row" }, SET.id === BUNDLED.id ? h("button", { class: "btn", onclick: useSample }, "Try with sample data") : null, h("a", { class: "btn ghost", href: "#data" }, "Import listings"))));
    return wrap;
  }

  const p = market.prefs;
  const setPref = (patch: Partial<typeof p>) => { market.prefs = { ...p, ...patch }; saveMarket(SET.id, market); render(); };
  const wants = wantsFor(p.scope);
  const plan = optimizeCart(wants, snap, {
    usdToCad: col.settings.usdToCad, mode: p.mode, conditions: p.conditions,
    tolerance: col.settings.overAbove, scalperAbove: col.settings.scalperAbove, onlyCountries: p.canadaOnly ? ["CA"] : undefined,
  });

  const when = new Date(snap.fetchedAt);
  wrap.append(
    h("p", { class: snap.sample ? "notice" : "hint" },
      snap.sample ? "Sample data: fictional sellers and made-up prices, so you can see how the optimizer works. " : `Prices from ${snap.sources?.filter((x) => x.ok).map((x) => x.name).join(", ") || "imported listings"}, updated ${when.toLocaleDateString("en-CA", { month: "short", day: "numeric" })}. `,
      h("button", { class: "linkish", onclick: () => { market = { ...market, source: "none", snapshot: undefined }; scoutTried = true; saveMarket(SET.id, market); render(); } }, "Clear price data")),
    h("div", { class: "panel controls" },
      h("div", { class: "seg", role: "radiogroup", "aria-label": "Goal" },
        h("button", { role: "radio", "aria-checked": String(p.mode === "value"), onclick: () => setPref({ mode: "value" }) }, "Best value"),
        h("button", { role: "radio", "aria-checked": String(p.mode === "complete"), onclick: () => setPref({ mode: "complete" }) }, "Complete the set")),
      h("p", { class: "hint" }, p.mode === "value"
        ? `Buys a card only when its price plus its share of shipping stays under its worth (market × ${Math.round(col.settings.overAbove * 100)}%, more for chase and high-priority cards).`
        : "Buys every card that's available at a fair price and keeps the total, shipping included, as low as possible."),
      h("div", { class: "row" },
        h("label", { class: "check" }, h("input", { id: "b-ca", type: "checkbox", checked: p.canadaOnly, onchange: (e: Event) => setPref({ canadaOnly: (e.target as HTMLInputElement).checked }) }), "Canadian sellers only"),
        h("label", { class: "check" }, h("input", { id: "b-prio", type: "checkbox", checked: p.scope === "priority", onchange: (e: Event) => setPref({ scope: (e.target as HTMLInputElement).checked ? "priority" : "all" }) }), "Chase & high priority only"),
        ...["NM", "LP", "MP"].map((cnd) => h("label", { class: "check" }, h("input", { id: `b-${cnd}`, type: "checkbox", checked: p.conditions.includes(cnd),
          onchange: (e: Event) => setPref({ conditions: (e.target as HTMLInputElement).checked ? [...p.conditions, cnd] : p.conditions.filter((x) => x !== cnd) }) }), cnd)))),
    cartSummary(plan, wants.length),
    ...plan.orders.map(orderPanel));
  if (plan.deferred.length) wrap.append(h("div", { class: "panel" },
    h("h2", {}, `Wait on these (${plan.deferred.length})`),
    h("p", { class: "hint" }, "Buying them now would cost more in shipping than they're worth. They'll join a cart once you're ordering from that seller anyway."),
    h("ul", { class: "reasons" }, ...plan.deferred.map((d) => h("li", {}, h("b", {}, d.label), " — ", d.reason)))));
  if (plan.unavailable.length) wrap.append(h("details", { class: "panel" },
    h("summary", {}, h("b", {}, `Not available at a fair price (${plan.unavailable.length})`)),
    h("ul", { class: "reasons" }, ...plan.unavailable.map((d) => h("li", {}, h("b", {}, d.label), " — ", d.reason)))));
  return wrap;
}

function cartSummary(plan: CartPlan, wanted: number) {
  const tile = (label: string, value: string, sub?: string) => h("div", { class: "tile" }, h("span", {}, label), h("strong", {}, value), sub ? h("small", {}, sub) : null);
  return h("div", { class: "tiles" },
    tile("Cards in cart", `${plan.cards}`, `of ${wanted} missing`),
    tile("Cards", formatCAD(plan.itemsTotal)),
    tile("Shipping", formatCAD(plan.shippingTotal), `${plan.orders.length} order${plan.orders.length === 1 ? "" : "s"}`),
    tile("Total", formatCAD(plan.total), plan.cards ? `${formatCAD(plan.total / plan.cards)} per card` : undefined),
    tile("Saved", formatCAD(plan.savings), "vs cheapest price per card"));
}

function orderPanel(o: CartPlan["orders"][number]) {
  const markOrdered = () => {
    for (const it of o.items) updateEntry(col, it.cardId, { status: "ordered", paid: it.price, store: o.seller.name.replace(/ \((sample )?eBay\)| \(sample\)/, "") });
    persist();
    toast(`Marked ${o.items.length} cards as ordered`);
    render();
  };
  const fs = o.freeShipping;
  return h("article", { class: "panel order" },
    h("header", { class: "order-head" },
      h("div", {}, h("h2", {}, o.seller.name), h("p", { class: "eyebrow" }, `${o.seller.country} · ${o.seller.kind === "marketplace" ? "marketplace seller" : "shop"} · prices in CAD`)),
      h("div", { class: "order-total" }, h("strong", {}, formatCAD(o.total)),
        h("small", {}, `${formatCAD(o.subtotal)} + ${o.shipping ? `${formatCAD(o.shipping)} shipping` : "free shipping"}`))),
    h("ul", { class: "order-items" }, ...o.items.map((it) => {
      const c = BY_ID.get(it.cardId)!;
      return h("li", {},
        cardThumb(c, "mini"),
        h("span", { class: "oi-name" }, h("b", {}, c.name), " ", h("span", { class: "num" }, c.number),
          it.listing.condition ? h("span", { class: "badge" }, it.listing.condition) : null),
        h("span", { class: "price" }, formatCAD(it.price), it.shipping ? h("small", {}, ` +${formatCAD(it.shipping)} ship`) : null),
        it.listing.url ? h("a", { href: it.listing.url, target: "_blank", rel: "noopener", class: "view-link" }, "View") : h("span"));
    })),
    o.seller.country !== "CA" ? h("p", { class: "hint" }, `Ships from ${o.seller.country === "US" ? "the US" : o.seller.country}: duties, taxes or brokerage fees may be added at the border. The optimizer picked it because it still came out cheaper; tick "Canadian sellers only" to compare.`) : null,
    fs ? h("p", { class: "freeship" }, `Add ${formatCAD(fs.needed)} more here to ship free and save ${formatCAD(fs.saves)}.`,
      fs.options.length ? ` Cards you need that they have: ${fs.options.slice(0, 5).map((x) => `${x.label} ${formatCAD(x.price)}`).join(", ")}${fs.options.length > 5 ? "…" : ""}.` : "") : null,
    h("div", { class: "row" }, h("button", { class: "btn ghost", onclick: markOrdered }, "I placed this order")));
}

function marketPanel(): Node {
  const msg = h("p", { class: "hint", role: "status" });
  const file = h("input", { id: "listings-file", type: "file", accept: ".csv,.xlsx,.json", class: "sr-only",
    onchange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      try {
        const buf = await f.arrayBuffer();
        let snap: MarketSnapshot;
        if (/\.json$/i.test(f.name)) snap = JSON.parse(new TextDecoder().decode(buf));
        else {
          const rows = /\.xlsx$/i.test(f.name) ? (await readXlsx(buf))[0].rows.map((r) => r.map((c) => (c == null ? null : String(c)))) : parseCSV(new TextDecoder().decode(buf));
          const resolve = (num: string, section?: string) => {
            const n = num.replace(/^0+(\d)/, "$1");
            return SET.cards.find((c) => (c.number === num || c.number.replace(/^0+(\d)/, "$1") === n) && (!section || c.section === section))?.id;
          };
          const r = listingsFromRows(rows, resolve);
          snap = { fetchedAt: new Date().toISOString(), sellers: r.sellers, listings: r.listings, sources: [{ name: f.name, ok: true, listings: r.listings.length }] };
          msg.textContent = `Loaded ${r.listings.length} listings from ${r.sellers.length} sellers${r.skipped ? `; skipped ${r.skipped} rows` : ""}.`;
        }
        market = { ...market, source: "import", snapshot: snap };
        if (!saveMarket(SET.id, market)) msg.textContent += " (Too big to keep in this browser; re-import next time.)";
        render();
      } catch (err) { msg.textContent = (err as Error).message; }
    } });
  const sellers = withOverrides(market)?.sellers ?? [];
  const ruleInput = (id: string, k: keyof ShippingRule, v: number | undefined, label: string) =>
    h("input", { id: `ship-${id}-${k}`, type: "number", min: "0", step: "0.01", value: v ?? "", "aria-label": label,
      onchange: (e: Event) => {
        const val = (e.target as HTMLInputElement).value;
        const cur: ShippingRule = { base: 0, ...(withOverrides(market)!.sellers.find((s) => s.id === id)?.shipping ?? {}) };
        if (val === "") delete cur[k]; else (cur as unknown as Record<string, number>)[k] = Number(val);
        market.shipping[id] = cur; saveMarket(SET.id, market);
      } });
  return h("div", { class: "panel" }, h("h2", {}, "Seller prices & shipping"),
    h("p", { class: "hint" }, "Import a listings sheet with columns Seller, Card #, Price, Qty, Condition, Shipping (the shop's order shipping) and Free over (its free-shipping line). Edit any shop's shipping below; the Buy tab uses your numbers."),
    file, h("div", { class: "row" }, h("label", { class: "btn", for: "listings-file" }, "Import listings"), sellers.length || SET.id !== BUNDLED.id ? null : h("button", { class: "btn ghost", onclick: useSample }, "Load sample data")), msg,
    sellers.filter((s) => s.kind === "store").length ? h("div", { class: "table-wrap" }, h("table", { class: "list ship" },
      h("thead", {}, h("tr", {}, ...["Shop", "Currency", "Shipping", "Each extra", "Free over"].map((t) => h("th", {}, t)))),
      h("tbody", {}, ...sellers.filter((s) => s.kind === "store").map((s) => h("tr", {},
        h("td", {}, s.name), h("td", {}, s.currency),
        h("td", {}, ruleInput(s.id, "base", s.shipping?.base, `${s.name} shipping`)),
        h("td", {}, ruleInput(s.id, "perExtra", s.shipping?.perExtra, `${s.name} each extra item`)),
        h("td", {}, ruleInput(s.id, "freeOver", s.shipping?.freeOver, `${s.name} free shipping over`))))))) : null);
}

// ---------- Packs vs singles ----------
function cardValue(): (id: string) => number | undefined {
  const snap = withOverrides(market);
  const cheapest = new Map<string, number>();
  if (snap) {
    const cur = new Map(snap.sellers.map((x) => [x.id, x.currency]));
    for (const l of snap.listings) {
      if (l.qty <= 0) continue;
      const v = cur.get(l.sellerId) === "USD" ? l.price * col.settings.usdToCad : l.price;
      if (!cheapest.has(l.cardId) || v < cheapest.get(l.cardId)!) cheapest.set(l.cardId, v);
    }
  }
  return (id) => marketOf(id) ?? cheapest.get(id);
}

let packTimer = 0;
let hitDraft: string[] = [];

function packs(): Node {
  void ensureMarket();
  const s = col.settings;
  const bundled = SET.id === BUNDLED.id;
  const regular = bundled ? ["Regular"] : SET.rarities.filter((r) => /^(common|uncommon)$/i.test(r));
  const hitRarities = bundled ? Object.keys(DEFAULT_MODEL.hitOdds) : SET.rarities.filter((r) => !regular.includes(r) && !/unknown|none/i.test(r));
  const model = bundled
    ? { ...DEFAULT_MODEL, hitOdds: { ...DEFAULT_MODEL.hitOdds, ...(col.packOdds ?? {}) } }
    : { pikachuSlot: false, energySlot: false, regularSlots: 9, regular, hitOdds: Object.fromEntries(Object.entries(col.packOdds ?? {}).filter(([r]) => hitRarities.includes(r))) };
  const sessions = col.packs ?? [];
  const obs = observedRates(sessions, (id) => BY_ID.get(id)?.rarity);
  const out = h("div", { class: "pack-out" }, h("p", { class: "hint" }, "Running the numbers…"));

  const run = () => {
    const ownedSet = new Set(SET.cards.filter((c) => owned(statusOf(c.id)) || statusOf(c.id) === "ordered").map((c) => c.id));
    if (!bundled && !Object.keys(model.hitOdds).length) {
      out.replaceChildren(h("p", { class: "hint" }, `Enter the pull odds for ${SET.name} on the left (from published pull rates or your own packs) to compare ripping with buying singles.`));
      return;
    }
    const a = analysePacks({ cards: SET.cards, owned: ownedSet, value: cardValue(), model, packPrice: s.packPrice, maxPacks: 60, resaleShare: s.resaleShare, runs: 900 });
    if (!a.priced) {
      out.replaceChildren(h("p", { class: "hint" }, "Add market values to your missing cards (or load price data on the Buy tab) so the cost of buying singles can be worked out."));
      return;
    }
    const save = a.singlesOnly - a.best.total;
    const headline = a.best.packs === 0
      ? h("div", { class: "verdict-big vb-keep-raw" }, h("strong", {}, "Buy singles"),
          h("span", {}, `Each pack only brings about ${formatCAD(a.perPackNewValue)} of cards you still need, for ${formatCAD(s.packPrice)}. Ripping now mostly gets you duplicates.`))
      : h("div", { class: "verdict-big vb-grade" }, h("strong", {}, a.best.packs >= 60 ? "Keep ripping" : `Open about ${a.best.packs} packs, then buy singles`),
          h("span", {}, `Expected total ${formatCAD(a.best.total)} vs ${formatCAD(a.singlesOnly)} buying every missing card as a single (${formatCAD(save)} less). Right now a pack brings about ${formatCAD(a.perPackNewValue)} of cards you need.`));
    out.replaceChildren(headline, packChart(a.points, a.best.packs, a.singlesOnly),
      h("p", { class: "fine" }, `${a.priced} missing cards priced${a.unpriced ? `, ${a.unpriced} without a price (left out)` : ""}. Duplicate hits count at ${Math.round(s.resaleShare * 100)}% of their value if you sell or trade them. Averages of 900 simulated runs; your packs will vary.`));
  };
  clearTimeout(packTimer);
  packTimer = window.setTimeout(run, 30);

  const setting = (k: "packPrice" | "resaleShare", label: string, step: string, pct = false) =>
    h("label", { class: "field" }, h("span", {}, label), h("input", { id: `p-${k}`, type: "number", min: "0", step, value: pct ? Math.round(s[k] * 100) : s[k],
      onchange: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); updateSettings(col, { [k]: pct ? v / 100 : v }); persist(); render(); } }));

  const oddsRows = hitRarities.map((rarity) => [rarity, model.hitOdds[rarity]] as [string, number | undefined]).map(([rarity, p]) => h("tr", {},
    h("td", {}, rarity),
    h("td", {}, h("span", { class: "one-in" }, "1 in ", h("input", { id: `odds-${rarity}`, type: "number", min: "1", step: "1", value: p ? Math.round(1 / p) : "", placeholder: "?", "aria-label": `${rarity}: one in how many packs`,
      onchange: (e: Event) => {
        const n = Number((e.target as HTMLInputElement).value);
        const next = { ...(col.packOdds ?? {}) };
        if (n >= 1) next[rarity] = 1 / n; else delete next[rarity];
        col.packOdds = next; persist(); render();
      } }))),
    h("td", { class: "n" }, obs.packs ? (obs.counts[rarity] ? `${obs.counts[rarity]} in ${obs.packs}` : `0 in ${obs.packs}`) : "—")));

  return h("section", { class: "view" },
    masthead({
      kicker: "Packs vs singles", title: "Rip, or buy singles?",
      lede: `SetKeeper opens ${SET.name} packs in simulation from where your binder is now and prices what's still missing, so you know when ripping stops paying off.`,
      meta: [["Pack price", formatCAD(s.packPrice)], ["Packs logged", String(obs.packs)], ["Missing", String(SET.cards.filter((c) => missing(statusOf(c.id))).length)], ["Runs", "900"]],
      scene: { kind: "pack", title: SET.name, sub: "Booster pack", color: "#3a2a6b", cards: missingTop(3).map((c) => ({ ...stageCard(c), ghost: false })) },
    }),
    h("div", { class: "planner" },
      h("div", { class: "panel" },
        setting("packPrice", "Price per pack (CAD)", "0.01"),
        setting("resaleShare", "Value you get back from duplicate hits (%)", "5", true),
        h("h2", {}, "Pull odds"),
        h("p", { class: "hint" }, "Starting guesses, not official rates. Replace them with published pull rates, or log your packs below and compare."),
        h("div", { class: "table-wrap" }, h("table", { class: "list odds-table" }, h("thead", {}, h("tr", {}, h("th", {}, "Hit"), h("th", {}, "Odds"), h("th", {}, "Your packs"))), h("tbody", {}, ...oddsRows))),
        col.packOdds ? h("button", { class: "linkish", onclick: () => { col.packOdds = undefined; persist(); render(); } }, "Reset odds") : null),
      h("div", { class: "panel grow" }, out)),
    packLog(sessions, obs.packs));
}

function packChart(points: { packs: number; total: number }[], best: number, singles: number): Node {
  const W = 640, H = 240, L = 64, R = 16, T = 16, B = 34;
  const max = Math.max(...points.map((p) => p.total), singles) * 1.05, min = Math.min(...points.map((p) => p.total)) * 0.9;
  const x = (k: number) => L + ((W - L - R) * k) / (points.length - 1);
  const y = (v: number) => T + (H - T - B) * (1 - (v - min) / (max - min || 1));
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.packs).toFixed(1)},${y(p.total).toFixed(1)}`).join("");
  const ticks = [0, 0.5, 1].map((f) => min + (max - min) * f);
  const bp = points[best];
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Expected total cost by packs opened. Lowest at ${best} packs: ${formatCAD(bp.total)}.`);
  svg.innerHTML =
    ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="tick">$${Math.round(v)}</text>`).join("") +
    [0, 15, 30, 45].filter((k) => k < points.length).map((k) => `<text x="${x(k)}" y="${H - 12}" text-anchor="middle" class="tick">${k}</text>`).join("") +
    `<text x="${W - R}" y="${H - 12}" text-anchor="end" class="tick">packs opened →</text>` +
    `<line x1="${L}" x2="${W - R}" y1="${y(singles)}" y2="${y(singles)}" class="ref"/><text x="${W - R}" y="${y(singles) - 6}" text-anchor="end" class="tick">singles only</text>` +
    `<path d="${path} L${x(points.length - 1)},${H - B} L${x(0)},${H - B} Z" class="area"/><path d="${path}" class="line"/>` +
    `<circle cx="${x(best)}" cy="${y(bp.total)}" r="6" class="dot"/><text x="${Math.min(x(best) + 10, W - 150)}" y="${y(bp.total) + 20}" class="tick strong">best: ${best} packs, ${formatCAD(bp.total)}</text>`;
  return h("div", { class: "chart-wrap" }, svg);
}

function packLog(sessions: PackSession[], totalPacks: number): Node {
  const hitCards = SET.cards.filter((c) => !["Regular", "Energy"].includes(c.rarity));
  const chips = h("div", { class: "chips" });
  const drawChips = () => chips.replaceChildren(...hitDraft.map((id) => {
    const c = BY_ID.get(id)!;
    return h("button", { class: "chip on", onclick: () => { hitDraft = hitDraft.filter((x) => x !== id); drawChips(); } }, `${c.name} ${c.number} ×`);
  }));
  drawChips();
  const hitInput = h("input", { id: "hit-search", type: "search", placeholder: "Add a hit: type a name or number", list: "hit-list",
    onchange: (e: Event) => {
      const v = (e.target as HTMLInputElement).value.trim().toLowerCase();
      if (!v) return;
      const c = hitCards.find((x) => `${x.name} ${x.number}`.toLowerCase() === v) ?? hitCards.find((x) => x.number.toLowerCase() === v || `${x.name} ${x.number}`.toLowerCase().includes(v));
      if (c) { hitDraft.push(c.id); drawChips(); (e.target as HTMLInputElement).value = ""; }
    } });
  const list = h("datalist", { id: "hit-list" }, ...hitCards.map((c) => h("option", { value: `${c.name} ${c.number}` })));
  const n = h("input", { id: "pl-packs", type: "number", min: "1", step: "1", value: "1" });
  const price = h("input", { id: "pl-price", type: "number", min: "0", step: "0.01", value: col.settings.packPrice });
  const store = h("input", { id: "pl-store", type: "text", placeholder: "Where" });
  const add = () => {
    const packsN = Number(n.value);
    if (!(packsN >= 1)) return toast("Enter how many packs you opened.");
    const sess: PackSession = { id: String(Date.now()), date: new Date().toISOString().slice(0, 10), packs: packsN, pricePerPack: Number(price.value) || 0, store: store.value || undefined, hits: hitDraft };
    col.packs = [sess, ...(col.packs ?? [])];
    for (const id of hitDraft) if (!owned(statusOf(id))) updateEntry(col, id, { status: "have" });
    hitDraft = [];
    persist();
    toast(`Logged ${packsN} pack${packsN === 1 ? "" : "s"}`);
    render();
  };
  const value = cardValue();
  const spent = sessions.reduce((a, x) => a + x.packs * x.pricePerPack, 0);
  const pulled = sessions.reduce((a, x) => a + x.hits.reduce((b, id) => b + (value(id) ?? 0), 0), 0);
  return h("div", { class: "panel" },
    h("h2", {}, "Pack log"),
    h("p", { class: "hint" }, "Log what you open. Hits you add are marked as owned, and your own pull rates show next to the odds above."),
    h("div", { class: "three" }, h("label", { class: "field" }, h("span", {}, "Packs opened"), n), h("label", { class: "field" }, h("span", {}, "Price each (CAD)"), price), h("label", { class: "field" }, h("span", {}, "Store"), store)),
    hitInput, list, chips,
    h("div", { class: "row" }, h("button", { class: "btn", onclick: add }, "Log packs")),
    sessions.length ? h("div", { class: "log-sum" },
      h("span", {}, `${totalPacks} packs · ${formatCAD(spent)} spent`),
      h("span", {}, `Hits worth ${formatCAD(pulled)} at today's prices`),
      h("span", { class: pulled >= spent ? "pos" : "neg" }, pulled >= spent ? `Up ${formatCAD(pulled - spent)}` : `Down ${formatCAD(spent - pulled)}`)) : null,
    sessions.length ? h("ul", { class: "sessions" }, ...sessions.slice(0, 12).map((x) => h("li", {},
      h("b", {}, `${x.date} · ${x.packs} pack${x.packs === 1 ? "" : "s"}`), x.store ? ` at ${x.store}` : "", " — ",
      x.hits.length ? x.hits.map((id) => `${BY_ID.get(id)?.name} ${BY_ID.get(id)?.number}`).join(", ") : "no hits logged",
      h("button", { class: "linkish del", "aria-label": "Delete this entry", onclick: () => { col.packs = (col.packs ?? []).filter((y) => y.id !== x.id); persist(); render(); } }, "Delete")))) : null);
}

// ---------- sync & backup ----------
function syncPanel(download: (text: string, name: string, type: string) => () => void): Node {
  const panel = h("div", { class: "panel sync-panel" });
  const stamp = () => new Date().toISOString().slice(0, 10);
  const restoreInput = h("input", { id: "restore-file", type: "file", accept: ".json,application/json", class: "sr-only",
    onchange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      try { restore(await f.text()); toast("Backup restored"); setTimeout(() => location.reload(), 600); }
      catch (err) { toast((err as Error).message); }
    } });
  const backupRow = h("div", { class: "row" },
    h("button", { class: "btn ghost", onclick: download(backupText(), `setkeeper-backup-${stamp()}.json`, "application/json") }, "Download a backup"),
    restoreInput, h("label", { class: "btn ghost", for: "restore-file" }, "Restore a backup"),
    hasPreSyncCopy() ? h("button", { class: "linkish", onclick: download(preSyncText(), `setkeeper-before-first-sync.json`, "application/json") }, "Copy of this device before the first sync") : "");
  const draw = () => {
    const kids: (Node | string)[] = [h("h2", {}, "Sync & backup")];
    if (!syncEnabled) {
      kids.push(h("p", { class: "hint" }, "Everything you enter is saved in this browser. Download a backup now and then, and restore it on another device or after clearing your browser."));
    } else if (!syncState.email) {
      kids.push(
        h("p", { class: "hint" }, "Sign in to keep your binders on all your devices and safe in the cloud. No password: we email you a sign-in link. Your collection keeps working offline either way."),
        h("button", { class: "btn", onclick: signInDialog }, "Sign in"),
        syncState.error ? h("p", { class: "hint warn", role: "status" }, syncState.error) : "");
    } else {
      const when = syncState.last ? new Date(syncState.last).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "not yet";
      kids.push(
        h("p", {}, h("b", {}, syncState.email), " · ", syncState.busy ? "syncing…" : `last synced ${when}`),
        syncState.error ? h("p", { class: "hint warn", role: "status" }, syncState.error) : "",
        h("p", { class: "hint" }, "Sync is automatic: a few seconds after each change, when you come back to the app, and every minute while it's open. Only your own data is uploaded: binders, card statuses, notes, prices and imported listings."),
        h("div", { class: "row" },
          h("button", { class: "btn ghost", onclick: () => void signOut().then(render) }, "Sign out"),
          (() => { let armed = false; const b = h("button", { class: "linkish del", onclick: async () => {
            if (!armed) { armed = true; b.textContent = "Tap again: deletes the cloud copy, keeps this device's data"; return; }
            await deleteCloudCopy(); toast("Cloud copy deleted"); render();
          } }, "Delete my cloud copy"); return b; })()));
    }
    kids.push(h("h3", {}, "Backup file"), h("p", { class: "hint" }, "One file with all your binders and card data. Keep it somewhere safe; restoring replaces what's on this device."), backupRow);
    panel.replaceChildren(...kids);
  };
  const off = onSyncChange(() => { if (panel.isConnected) draw(); else off(); });
  draw();
  return panel;
}

// ---------- account (header) ----------
function syncLabel(): { text: string; tone: "ok" | "busy" | "warn" } {
  if (syncState.busy) return { text: "Syncing…", tone: "busy" };
  if (syncState.error) return { text: syncState.error, tone: "warn" };
  if (!syncState.last) return { text: "Waiting to sync", tone: "busy" };
  return { text: `Synced ${new Date(syncState.last).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}`, tone: "ok" };
}
function renderAccount() {
  const slot = document.querySelector("#account");
  if (!slot) return;
  if (!syncEnabled) { slot.replaceChildren(); return; }
  if (!syncState.email) { slot.replaceChildren(h("button", { class: "acct-btn", onclick: signInDialog }, "Sign in")); return; }
  const st = syncLabel();
  slot.replaceChildren(h("button", { class: `acct-btn signed tone-${st.tone}`, title: `${syncState.email} · ${st.text}`, "aria-label": `Account: ${syncState.email}. ${st.text}`, onclick: accountDialog },
    h("span", { class: "acct-dot", "aria-hidden": "true" }), h("span", { class: "acct-initial", "aria-hidden": "true" }, syncState.email[0]?.toUpperCase() ?? "?")));
}
function signInDialog() {
  const dlg = $("#sheet") as HTMLDialogElement;
  const email = h("input", { id: "signin-email", type: "email", autocomplete: "email", required: true, placeholder: "you@example.com", "aria-label": "Email" }) as HTMLInputElement;
  const msg = h("p", { class: "hint", role: "status" }, syncState.error);
  const send = h("button", { class: "btn", type: "submit" }, "Email me a sign-in link");
  dlg.replaceChildren(h("form", { method: "dialog", class: "sheet-inner" },
    h("header", { class: "sheet-head" }, h("div", {}, h("p", { class: "eyebrow" }, "Account"), h("h2", {}, "Sign in")),
      h("button", { class: "close", value: "close", "aria-label": "Close" }, "×")),
    h("div", { class: "sheet-pad" },
      h("p", { class: "hint" }, "No password. Enter your email and open the link we send you on this device. Your binders then sync automatically across your phone, tablet and computer."),
      h("div", { class: "row", onsubmit: (e: Event) => e.preventDefault() }, email, send), msg)));
  send.onclick = async (e: Event) => {
    e.preventDefault();
    if (!email.validity.valid) { msg.textContent = "Enter your email address."; email.focus(); return; }
    send.setAttribute("disabled", ""); msg.textContent = "Sending…";
    try { await sendLink(email.value); msg.textContent = `Check ${email.value} for a sign-in link and open it on this device. You can close this window.`; }
    catch (err) { msg.textContent = (err as Error).message; send.removeAttribute("disabled"); }
  };
  dlg.onclose = null;
  dlg.showModal();
  email.focus();
}
function accountDialog() {
  const dlg = $("#sheet") as HTMLDialogElement;
  const body = h("div", { class: "sheet-pad" });
  const draw = () => {
    const st = syncLabel();
    body.replaceChildren(
      h("p", {}, h("b", {}, syncState.email)),
      h("p", { class: `acct-status tone-${st.tone}`, role: "status" }, h("span", { class: "acct-dot", "aria-hidden": "true" }), st.text),
      h("p", { class: "hint" }, "Your binders sync automatically: a few seconds after each change, when you come back to the app, and every minute while it's open. Changes made offline sync when you're back online."),
      h("div", { class: "row" },
        h("button", { class: "btn ghost", onclick: () => void signOut().then(() => { dlg.close(); toast("Signed out. Your data stays on this device."); }) }, "Sign out"),
        h("a", { class: "btn ghost", href: "#data", onclick: () => dlg.close() }, "Backup & more")),
      h("p", { class: "hint small" }, "Signing out keeps everything on this device; it just stops syncing here."));
  };
  const off = onSyncChange(() => { if (dlg.open) draw(); else off(); });
  draw();
  dlg.replaceChildren(h("form", { method: "dialog", class: "sheet-inner" },
    h("header", { class: "sheet-head" }, h("div", {}, h("p", { class: "eyebrow" }, "Account"), h("h2", {}, "Signed in")),
      h("button", { class: "close", value: "close", "aria-label": "Close" }, "×")), body));
  dlg.onclose = null;
  dlg.showModal();
}

// ---------- boot ----------
async function boot() {
  onSyncChange(renderAccount);
  initSync(() => location.reload());
  renderAccount();
  void persistStorage();
  const brand = document.querySelector(".brand") as HTMLElement;
  brand.addEventListener("click", () => { location.hash = "#home"; scrollTo({ top: 0 }); });
  brand.setAttribute("role", "link"); brand.tabIndex = 0;
  await activateSet(shelf.activeSet || BUNDLED.id);
  document.querySelectorAll("nav").forEach((nav) =>
    nav.replaceChildren(...NAV.map((v) => h("a", { href: `#${v}`, "data-view": v }, VIEW_LABEL[v]))));
  setupHolo();
  window.addEventListener("hashchange", render);
  render();
}
void boot();
