// Checks each grading company's pricing page and updates data/grading/services.json:
// tier prices and whether each tier is open, limited or paused. Run daily by
// .github/workflows/scout.yml. If a page can't be read, that company keeps its last
// known data and the failure is recorded, so nothing is guessed.
import { readFileSync, writeFileSync } from "node:fs";
import type { ServicesFile, Tier, TierStatus } from "../src/lib/grading.ts";

const FILE = "data/grading/services.json";

/** Page HTML → plain text. */
export function textOf(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#36;/g, "$").replace(/\s+/g, " ");
}

const PAUSED = /\b(paused|unavailable|sold out|temporarily closed|not accepting|coming soon|waitlist|closed)\b/i;
const LIMITED = /\b(limited (?:capacity|availability|spots)|while capacity lasts|limited)\b/i;

/** Read one tier's price and status from the text that follows its name. */
export function readTier(text: string, name: string, others: string[] = []): { price?: number; status?: TierStatus } | undefined {
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
  let best: { price?: number; status?: TierStatus } | undefined;
  for (const m of text.matchAll(re)) {
    let win = text.slice(m.index!, m.index! + 220);
    // stop at the next tier's name so one tier's words don't leak into another
    let cut = win.length;
    for (const o of others) {
      if (o === name) continue;
      const i = win.slice(name.length).search(new RegExp(`\\b${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
      if (i >= 0) cut = Math.min(cut, i + name.length);
    }
    win = win.slice(0, cut);
    const price = win.match(/\$\s?(\d{1,4}(?:\.\d{2})?)/);
    const status: TierStatus | undefined = PAUSED.test(win) ? "paused" : LIMITED.test(win) ? "limited" : price ? "open" : undefined;
    const hit = { ...(price ? { price: Number(price[1]) } : {}), ...(status ? { status } : {}) };
    if (hit.price != null || hit.status) { best = hit; if (hit.price != null) break; }
  }
  return best;
}

/** Apply what the page says to a company's tiers. Returns human-readable changes. */
export function applyPage(tiers: Tier[], text: string, today: string): string[] {
  const changes: string[] = [];
  for (const t of tiers) {
    const r = readTier(text, t.name, tiers.map((x) => x.name));
    if (!r) continue;
    if (r.status && r.status !== t.status && t.status !== "unconfirmed") {
      changes.push(`${t.name}: ${t.status} → ${r.status}`);
      t.status = r.status;
      t.since = today;
    }
    if (r.price != null && r.price > 0 && r.price !== t.price) {
      changes.push(`${t.name}: $${t.price ?? "?"} → $${r.price}`);
      t.price = r.price;
    }
  }
  return changes;
}

async function main() {
  const data = JSON.parse(readFileSync(FILE, "utf8")) as ServicesFile & { log?: string[] };
  const today = new Date().toISOString().slice(0, 10);
  const log: string[] = [];
  for (const c of data.companies) {
    try {
      const res = await fetch(c.url, { headers: { "User-Agent": "Mozilla/5.0 (SetKeeper grading scout)", Accept: "text/html" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const changes = applyPage(c.tiers, textOf(await res.text()), today);
      c.checkedAt = today;
      c.source = c.url;
      log.push(`${c.name}: ${changes.length ? changes.join("; ") : "no changes"}`);
    } catch (e) {
      log.push(`${c.name}: couldn't read ${c.url} (${(e as Error).message}); kept data from ${c.checkedAt}`);
    }
  }
  data.checkedAt = today;
  data.log = log;
  writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n");
  console.log(log.join("\n"));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
