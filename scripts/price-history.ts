// SetKeeper's own market price history: every English card's TCGplayer and Cardmarket figures
// for each printing (normal, holofoil, reverse holo, 1st edition…), saved to the private
// Supabase table card_prices as changes only (a row when a figure changes; see record_prices
// in supabase/setup.sql).
//   TCGplayer (USD): low (cheapest listing, any condition), mid, market (recent sales), high
//   Cardmarket (EUR): low, trend, 30-day average
// Source: TCGdex (free, open). The tracked sets (data/landed/tracked-sets.json) go first, then
// every other set, newest first, within a time budget. Run daily by .github/workflows/scout.yml;
// needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
import { readFileSync } from "node:fs";
import { priceRows, type PriceRow } from "../src/lib/prices.ts";
import { summariesFrom } from "../src/lib/catalog.ts";

const TCGDEX = "https://api.tcgdex.net/v2/en";
const BUDGET_MS = 30 * 60_000;
const WORKERS = 6;
const sb = process.env.SUPABASE_URL?.replace(/\/$/, ""), key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!sb || !key) { console.log("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set; skipping."); process.exit(0); }
const started = Date.now();
const day = new Date().toISOString().slice(0, 10);
const getJson = async (u: string) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.json(); };
const notice = (m: string) => { console.log(m); if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Market prices::${m}`); };

const { sets: tracked } = JSON.parse(readFileSync("data/landed/tracked-sets.json", "utf8")) as { sets: string[] };
const all = summariesFrom(await getJson(`${TCGDEX}/sets`));
const order = [...tracked, ...all.map((s) => s.id).reverse().filter((id) => !tracked.includes(id))];

async function save(rows: PriceRow[]): Promise<number> {
  let changed = 0;
  for (let i = 0; i < rows.length; i += 2000) {
    const body = rows.slice(i, i + 2000).map(({ day: _d, ...r }) => r);
    const res = await fetch(`${sb}/rest/v1/rpc/record_prices`, {
      method: "POST", headers: { apikey: key!, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_day: day, p_rows: body }),
    });
    if (!res.ok) throw new Error(`saving failed, HTTP ${res.status} ${await res.text()}`);
    changed += Number(await res.json()) || 0;
  }
  return changed;
}

let setsDone = 0, cards = 0, printings = 0, changed = 0, failed = 0;
for (const setId of order) {
  if (Date.now() - started > BUDGET_MS) break;
  let list: { id: string }[];
  try { list = (await getJson(`${TCGDEX}/sets/${encodeURIComponent(setId)}`)).cards ?? []; }
  catch (e) { console.warn(`${setId}: ${(e as Error).message}`); continue; }
  const rows: PriceRow[] = [];
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const c = list[next++];
      try { const r = priceRows(c.id, setId, day, (await getJson(`${TCGDEX}/cards/${encodeURIComponent(c.id)}`)).pricing); if (r.length) { rows.push(...r); cards++; } }
      catch { failed++; }
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
  if (!rows.length) { setsDone++; continue; }
  try { changed += await save(rows); printings += rows.length; setsDone++; }
  catch (e) { console.error(`${setId}: ${(e as Error).message}`); process.exitCode = 1; }
}
notice(`${setsDone} of ${order.length} sets, ${cards} cards, ${printings} printings checked; ${changed} price changes saved for ${day}${failed ? `; ${failed} cards couldn't be read` : ""} (${Math.round((Date.now() - started) / 60000)} min)`);
