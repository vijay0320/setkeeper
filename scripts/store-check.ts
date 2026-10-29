// One-off check of candidate card shops for the directory (data/stores/candidates.json).
// For each shop it loads the homepage and its public shipping policy once, like a person
// visiting, with a pause between shops. It never reads inventory, carts or accounts.
// Output: data/stores/check-report.json, which is reviewed by hand before any shop is
// added to data/stores/stores.json. Run from Actions → "Check candidate shops".
import { readFileSync, writeFileSync } from "node:fs";

const UA = "SetKeeper store directory check (+https://github.com/vijay0320/setkeeper)";
const PAUSE_MS = 2000;
const POLICY_PATHS = ["/policies/shipping-policy", "/pages/shipping", "/pages/shipping-policy", "/pages/shipping-information", "/pages/faq"];

interface Candidate { name: string; url: string; province: string | null; location: string; known: boolean }

const text = (html: string) => html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#36;/g, "$")
  .replace(/&#39;|&rsquo;/g, "'").replace(/&eacute;/g, "é").replace(/\s+/g, " ").trim();

async function get(url: string): Promise<{ ok: boolean; status: number; url: string; body: string }> {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    const body = r.ok ? await r.text() : "";
    return { ok: r.ok, status: r.status, url: r.url, body };
  } catch (e) {
    return { ok: false, status: 0, url, body: String((e as Error).message) };
  }
}

/** Sentences that mention money, free shipping, mail types or thresholds. */
function shippingFacts(t: string): string[] {
  const s = t.split(/(?<=[.!?])\s+|\s{2,}|•/).map((x) => x.trim()).filter((x) => x.length > 12 && x.length < 400);
  const re = /(\$\s?\d|free (?:shipping|delivery)|lettermail|letter mail|bubble|untracked|tracked|expedited|flat rate|canada post|ups|purolator|singles)/i;
  return [...new Set(s.filter((x) => re.test(x)))].slice(0, 14);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { candidates } = JSON.parse(readFileSync("data/stores/candidates.json", "utf8")) as { candidates: Candidate[] };
const report: unknown[] = [];

for (const c of candidates) {
  const home = await get(c.url);
  const origin = home.ok ? new URL(home.url).origin : c.url;
  const homeText = home.ok ? text(home.body) : "";
  const shopify = /cdn\.shopify\.com|Shopify\.theme|myshopify/i.test(home.body);
  let policy = { path: "", facts: [] as string[], chars: 0 };
  if (home.ok) {
    for (const p of POLICY_PATHS) {
      await sleep(600);
      const r = await get(origin + p);
      if (!r.ok) continue;
      const t = text(r.body);
      if (!/ship/i.test(t)) continue;
      policy = { path: p, facts: shippingFacts(t), chars: t.length };
      if (policy.facts.length) break;
    }
  }
  const pokemon = /pok[eé]mon/i.test(homeText);
  const singles = /pok[eé]mon[^.]{0,40}singles|singles[^.]{0,40}pok[eé]mon/i.test(homeText);
  const addr = homeText.match(/[^.]{0,80}\b(?:BC|AB|SK|MB|ON|QC|NB|NS|PE|NL|YT)\b\s?[A-Z]\d[A-Z]\s?\d[A-Z]\d/)?.[0]?.trim();
  report.push({
    name: c.name, url: c.url, finalUrl: home.url, status: home.status, listedProvince: c.province, location: c.location,
    title: home.body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim(), shopify, sellsPokemon: pokemon, mentionsPokemonSingles: singles,
    address: addr, policyPath: policy.path, shippingFacts: policy.facts,
  });
  console.log(`${home.ok ? "ok " : "ERR"} ${home.status} ${c.name} → ${policy.path || "no policy"} (${policy.facts.length} facts)${singles ? " · Pokémon singles" : pokemon ? " · Pokémon" : ""}`);
  await sleep(PAUSE_MS);
}

writeFileSync("data/stores/check-report.json", JSON.stringify({ checkedAt: new Date().toISOString(), shops: report }, null, 1) + "\n");
console.log(`checked ${report.length} shops`);
