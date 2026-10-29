// Saves today's prices of every card in the tracked sets (data/landed/tracked-sets.json)
// to the private Supabase table card_prices: SetKeeper's own price history.
//
// One row per card, per printing (normal, holofoil, reverse holo, 1st edition…), per day,
// with every figure the free source gives, so ranges and fair values can be computed
// later without guessing:
//   TCGplayer (USD): low (cheapest listing, any condition), mid, market (recent sales), high
//   Cardmarket (EUR): low, trend, 30-day average
// Source: TCGdex (free, open). Run daily by .github/workflows/scout.yml; needs SUPABASE_URL
// and SUPABASE_SERVICE_ROLE_KEY.
import { readFileSync } from "node:fs";
import { priceRows as rowsFor, type PriceRow } from "../src/lib/prices.ts";

const TCGDEX = "https://api.tcgdex.net/v2/en";
const sb = process.env.SUPABASE_URL?.replace(/\/$/, ""), key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!sb || !key) { console.log("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set; skipping."); process.exit(0); }
const { sets } = JSON.parse(readFileSync("data/landed/tracked-sets.json", "utf8")) as { sets: string[] };
const day = new Date().toISOString().slice(0, 10);
const getJson = async (u: string) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.json(); };

let saved = 0, cardsSaved = 0;
for (const setId of sets) {
  let cards: { id: string }[];
  try { cards = (await getJson(`${TCGDEX}/sets/${encodeURIComponent(setId)}`)).cards ?? []; }
  catch (e) { console.warn(`${setId}: ${(e as Error).message}`); continue; }
  const rows: PriceRow[] = [];
  let next = 0, priced = 0;
  const worker = async () => {
    while (next < cards.length) {
      const c = cards[next++];
      try {
        const r = rowsFor(c.id, setId, day, (await getJson(`${TCGDEX}/cards/${encodeURIComponent(c.id)}`)).pricing);
        if (r.length) { rows.push(...r); priced++; }
      } catch { /* skip this card today */ }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (!rows.length) { console.log(`${setId}: no prices`); continue; }
  const res = await fetch(`${sb}/rest/v1/card_prices?on_conflict=card_id,printing,day`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) { console.error(`${setId}: saving failed, HTTP ${res.status} ${await res.text()}`); process.exitCode = 1; continue; }
  saved += rows.length; cardsSaved += priced;
  console.log(`${setId}: ${priced}/${cards.length} cards, ${rows.length} printings`);
}
console.log(`saved ${saved} printing prices for ${cardsSaved} cards on ${day}`);
