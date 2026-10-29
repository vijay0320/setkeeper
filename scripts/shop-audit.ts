// Checks which directory shops (data/stores/stores.json) SetKeeper's price scout may read,
// and where. Run by hand from Actions → "Audit shops for the price scout".
//
// For each shop, once, like a person visiting, with a pause between requests:
//   1. robots.txt: is Shopify's public catalogue (/collections/…/products.json) allowed?
//   2. Terms of service: does it forbid scraping, crawling, robots or automated access?
//      (Only where robots.txt allows fetching the terms page; otherwise flagged for a person.)
//   3. /collections.json (Shopify's public list of collections, titles and counts only):
//      which collection holds a tracked set's singles, so the scout reads only that
//      collection instead of the whole store.
// Nothing about inventory, prices, carts or customers is saved. The report
// (data/stores/scout-audit.json) is reviewed by hand before a shop joins SCOUT_SELLERS.
import { readFileSync, writeFileSync } from "node:fs";

const UA = "SetKeeper price scout check (+https://github.com/vijay0320/setkeeper)";
const PAUSE = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// sets the scout can read titles for, with how shops name them
const SETS = [{ id: "30th-celebration", re: /30th|celebration/i, exclude: /sealed|booster|box|bundle|tin|etb|elite|collection box|premium|graded|slab|japanese/i }];

async function get(url: string): Promise<{ status: number; body: string; type: string }> {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json,text/html,text/plain" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    return { status: r.status, body: r.ok ? await r.text() : "", type: r.headers.get("content-type") ?? "" };
  } catch (e) {
    return { status: 0, body: String((e as Error).message), type: "" };
  }
}

/** Disallow rules that apply to every robot (and to us by name), from robots.txt. */
export function robotsRules(txt: string): string[] {
  const rules: string[] = [];
  let agents: string[] = [], inRules = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, k, v] = m;
    if (/^user-agent$/i.test(k)) { if (inRules) { agents = []; inRules = false; } agents.push(v.toLowerCase()); continue; }
    inRules = true;
    if (/^disallow$/i.test(k) && v && agents.some((a) => a === "*" || a.includes("setkeeper"))) rules.push(v);
  }
  return rules;
}
/** Whether a path is blocked by robots.txt Disallow rules (supports * and $). */
export function blocked(path: string, rules: string[]): string | undefined {
  return rules.find((r) => new RegExp("^" + r.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")).test(path));
}

/**
 * Passages in a terms page that restrict scraping or automated access. Terms often bury this
 * in one long list ("…to spam, phish, pharm, pretext, spider, crawl, or scrape…"), so each
 * mention is read with the text around it rather than sentence by sentence.
 */
export function tosFlags(text: string): string[] {
  const about = /scrap(e|ing|er)|\bcrawl|\bspider|\brobots?\b|\bbots?\b|data[\s-]?min|harvest|automated (means|system|device|access|process|tool|software)|automatic (means|device)/gi;
  const forbids = /\b(not|never|prohibit\w*|forbid\w*|may not|must not|shall not|without (our|the|prior|express)|agree not|restrict\w*)\b/i;
  const out: string[] = [];
  let last = -1000;
  for (const m of text.matchAll(about)) {
    const at = m.index ?? 0;
    if (at - last < 250) continue; // same passage
    // a list of prohibited uses can start long before the word itself
    const win = text.slice(Math.max(0, at - 1500), at + 120);
    if (!forbids.test(win)) continue;
    const snip = text.slice(Math.max(0, at - 140), at + 80).replace(/^\S*\s/, "").trim();
    out.push(`…${snip}…`);
    last = at;
  }
  return out.slice(0, 4);
}

const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, " ").trim();

interface Store { id: string; name: string; url: string }

async function audit(st: Store) {
  const origin = new URL(st.url).origin;
  const out: Record<string, unknown> = { id: st.id, name: st.name, origin };
  // 1. robots.txt
  const rb = await get(`${origin}/robots.txt`);
  const rules = rb.status === 200 ? robotsRules(rb.body) : [];
  await sleep(PAUSE);
  // 2. terms of service (Shopify's standard address, then common pages)
  // robots.txt is honoured here too: Shopify's default blocks /policies/, so those terms are
  // left for a person to read (termsByHand) rather than fetched by the script
  let flags: string[] = [], tosUrl = "";
  const byHand: string[] = [];
  for (const p of ["/policies/terms-of-service", "/pages/terms-of-service", "/pages/terms-and-conditions", "/pages/terms"]) {
    if (blocked(p, rules)) { if (p.startsWith("/policies/")) byHand.push(origin + p); continue; }
    const r = await get(origin + p);
    await sleep(PAUSE);
    if (r.status === 200 && /term/i.test(r.body)) { tosUrl = origin + p; flags = tosFlags(text(r.body)); break; }
  }
  // 3. collections (titles and counts only)
  const cols: { handle: string; title: string; products_count?: number }[] = [];
  let shopify = false;
  const colsBlocked = blocked("/collections.json", rules);
  for (let page = 1; page <= 4 && !colsBlocked; page++) {
    const r = await get(`${origin}/collections.json?limit=250&page=${page}`);
    await sleep(PAUSE);
    if (r.status !== 200 || !/json/.test(r.type)) break;
    try {
      const j = JSON.parse(r.body) as { collections?: { handle: string; title: string; products_count?: number }[] };
      if (!Array.isArray(j.collections)) break;
      shopify = true;
      if (!j.collections.length) break;
      cols.push(...j.collections.map((c) => ({ handle: c.handle, title: c.title, products_count: c.products_count })));
      if (j.collections.length < 250) break;
    } catch { break; }
  }
  const sets: Record<string, { handle: string; title: string; count?: number; robots?: string; readable?: boolean }[]> = {};
  for (const s of SETS) {
    const m = cols.filter((c) => s.re.test(c.title) && !s.exclude.test(c.title)).sort((a, b) => (b.products_count ?? 0) - (a.products_count ?? 0)).slice(0, 3);
    const found = [];
    for (const c of m) {
      const path = `/collections/${c.handle}/products.json`;
      const why = blocked(path, rules);
      let readable: boolean | undefined;
      if (!why) { const r = await get(`${origin}${path}?limit=1`); readable = r.status === 200 && /json/.test(r.type); await sleep(PAUSE); }
      found.push({ handle: c.handle, title: c.title, ...(c.products_count != null ? { count: c.products_count } : {}), ...(why ? { robots: `Disallow: ${why}` } : {}), ...(readable != null ? { readable } : {}) });
    }
    if (found.length) sets[s.id] = found;
  }
  const catalogBlocked = blocked("/products.json", rules) ?? blocked("/collections/x/products.json", rules);
  Object.assign(out, {
    shopify, robots: rb.status === 200 ? (catalogBlocked ? `blocks the catalogue (Disallow: ${catalogBlocked})` : "allows the catalogue") : `no robots.txt (HTTP ${rb.status})`,
    terms: tosUrl || (byHand.length ? "read by hand (robots.txt asks bots not to)" : "not found"), termsFlags: flags,
    ...(!tosUrl && byHand.length ? { termsByHand: byHand[0] } : {}), collections: cols.length, sets,
  });
  const usable = Object.values(sets).flat().some((x) => x.readable);
  out.verdict = !shopify ? "not a Shopify store: needs its own adapter or eBay"
    : catalogBlocked ? "robots.txt blocks the catalogue: skip"
    : flags.length ? "terms restrict automated access: skip unless the shop says yes"
    : !tosUrl && byHand.length ? (usable ? "check the terms by hand, then ok: read only the set collection(s)" : "check the terms by hand; no collection found for a tracked set")
    : usable ? "ok: read only the set collection(s) above" : "ok to read, but no collection found for a tracked set";
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { stores } = JSON.parse(readFileSync("data/stores/stores.json", "utf8")) as { stores: Store[] };
  const shops = [];
  for (const st of stores) {
    const a = await audit(st);
    shops.push(a);
    console.log(`${st.name}: ${a.verdict}`);
  }
  writeFileSync("data/stores/scout-audit.json", JSON.stringify({ checkedAt: new Date().toISOString(), note: "Which shops the price scout may read, and which collection. Titles and counts only; no inventory.", shops }, null, 1) + "\n");
}
