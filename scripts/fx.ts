// Daily USD→CAD and EUR→CAD rates from the Bank of Canada (public Valet API), used to put
// TCGplayer (USD) and Cardmarket (EUR) prices in Canadian dollars and for landed-cost
// estimates. Writes data/landed/fx.json. Run by .github/workflows/scout.yml.
import { writeFileSync } from "node:fs";

const res = await fetch("https://www.bankofcanada.ca/valet/observations/FXUSDCAD,FXEURCAD/json?recent=1");
if (!res.ok) { console.error(`Bank of Canada: HTTP ${res.status}`); process.exit(1); }
const j = await res.json() as { observations: { d: string; FXUSDCAD?: { v: string }; FXEURCAD?: { v: string } }[] };
const o = j.observations?.[0];
const usd = Number(o?.FXUSDCAD?.v), eur = Number(o?.FXEURCAD?.v);
if (!(usd > 0.5 && usd < 3) || !(eur > 0.5 && eur < 3)) { console.error("Bank of Canada: unexpected rates", o); process.exit(1); }
writeFileSync("data/landed/fx.json", JSON.stringify({ usdcad: usd, eurcad: eur, date: o!.d, source: "Bank of Canada daily exchange rates (FXUSDCAD, FXEURCAD), updated by the daily scout" }, null, 1) + "\n");
console.log(`USD→CAD ${usd}, EUR→CAD ${eur} on ${o!.d}`);
