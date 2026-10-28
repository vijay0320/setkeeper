// Reads the official Pokémon TCG card galleries and updates data/galleries/index.json:
// every expansion on tcg.pokemon.com/en-us/all-galleries/, its card count, the official
// categories (Special Art, Pokémon ex, Hyper Rare…), and the matching TCGdex set once the
// card database has it. A new expansion shows up in the app the day its gallery goes live.
// Run daily by .github/workflows/scout.yml.
//
// tcg.pokemon.com sits behind a bot check. Plain requests are tried first; if they're
// challenged, the scout loads the pages in headless Chromium (Playwright) instead.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  parseIndexPage, parseGalleryPage, versionsFromScript, idFoldersFromScript, cardsJsonPath, partFrom, matchTcgdex, mergeIndex,
  shortName, type Gallery, type GalleryIndex, type GalleryPart,
} from "../src/lib/galleries.ts";

const FILE = "data/galleries/index.json";
const ORIGIN = "https://tcg.pokemon.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const blocked = (s: string) => /_Incapsula_Resource|Request unsuccessful\. Incapsula/i.test(s) && s.length < 20000;

type Getter = (path: string) => Promise<string>;

async function plainGetter(): Promise<Getter> {
  return async (path) => {
    const r = await fetch(ORIGIN + path, { headers: { "user-agent": UA, accept: "text/html,application/json,*/*", "accept-language": "en-US,en" } });
    const t = await r.text();
    if (!r.ok || blocked(t)) throw new Error(`blocked (${r.status})`);
    return t;
  };
}

async function browserGetter(): Promise<{ get: Getter; close: () => Promise<void> }> {
  // optional dependency, installed in CI only: npm i --no-save playwright && npx playwright install chromium
  const { chromium } = await import("playwright" as string);
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: UA });
  await page.goto(`${ORIGIN}/en-us/all-galleries/`, { waitUntil: "networkidle", timeout: 60000 });
  return {
    get: (path) => page.evaluate(async (p: string) => { const r = await fetch(p); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); }, path),
    close: () => browser.close(),
  };
}

async function tcgdexSets(): Promise<{ id: string; name: string }[]> {
  try { const r = await fetch("https://api.tcgdex.net/v2/en/sets"); return r.ok ? await r.json() : []; } catch { return []; }
}

async function scrape(get: Getter, prev?: GalleryIndex): Promise<Gallery[]> {
  const list = parseIndexPage(await get("/en-us/all-galleries/"));
  if (!list.length) throw new Error("no galleries found on the index page");
  const idFolders = idFoldersFromScript(await get("/galleries/gallery.js"));
  const db = await tcgdexSets();
  const out: Gallery[] = [];
  for (const item of list) {
    try {
      const page = parseGalleryPage(await get(`/en-us/galleries/${item.slug}/`));
      const root = page.roots[0];
      if (!root) { console.warn(`${item.slug}: no card grid on the page`); continue; }
      // a custom script can split one page into several sets (e.g. Black Bolt / White Flare)
      let versions: string[] = [];
      for (const s of page.scripts) {
        try { versions.push(...versionsFromScript(await get(new URL(s, `${ORIGIN}/en-us/galleries/${item.slug}/`).pathname))); } catch { /* optional */ }
      }
      versions = [...new Set(versions)];
      if (!versions.length) versions = ["cards"];
      const old = prev?.galleries.find((g) => g.slug === item.slug);
      const parts: GalleryPart[] = [];
      for (const v of versions) {
        const json = JSON.parse(await get(cardsJsonPath(root, v, idFolders))) as Record<string, number[]>;
        const label = old?.parts.find((p) => p.version === v)?.label ?? (versions.length > 1 ? v.replace(/-cards$/, "").toUpperCase() : undefined);
        const part = partFrom(v, json, label);
        const name = label ?? shortName(item.name);
        parts.push({ ...part, tcgdex: matchTcgdex(name, db) });
      }
      out.push({
        slug: item.slug, name: item.name, code: page.code ?? "", galleryId: root.expansionId, assetPath: root.assetPath,
        ...(item.logo ? { logo: item.logo } : {}), firstSeen: "", filters: page.filters, parts,
      });
    } catch (e) {
      console.warn(`${item.slug}: ${(e as Error).message}`);
      const old = prev?.galleries.find((g) => g.slug === item.slug);
      if (old) out.push(old);
    }
  }
  return out;
}

async function main() {
  const prev = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as GalleryIndex) : undefined;
  const today = new Date().toISOString().slice(0, 10);
  let galleries: Gallery[];
  try {
    galleries = await scrape(await plainGetter(), prev);
  } catch (e) {
    console.log(`Plain requests didn't get through (${(e as Error).message}); using headless Chromium.`);
    const b = await browserGetter();
    try { galleries = await scrape(b.get, prev); } finally { await b.close(); }
  }
  const { index, added, changed } = mergeIndex(prev, galleries, today);
  writeFileSync(FILE, JSON.stringify(index, null, 1) + "\n");
  console.log(`${index.galleries.length} galleries. New: ${added.join(", ") || "none"}. Updated: ${changed.join(", ") || "none"}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
