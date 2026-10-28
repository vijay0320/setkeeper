// Daily USD→CAD rate from the Bank of Canada (public Valet API) for landed-cost estimates.
// Writes data/landed/fx.json. Run by .github/workflows/scout.yml.
import { writeFileSync } from "node:fs";

const res = await fetch("https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1");
if (!res.ok) { console.error(`Bank of Canada: HTTP ${res.status}`); process.exit(1); }
const j = await res.json() as { observations: { d: string; FXUSDCAD: { v: string } }[] };
const o = j.observations?.[0];
const rate = Number(o?.FXUSDCAD?.v);
if (!(rate > 0.5 && rate < 3)) { console.error("Bank of Canada: unexpected rate", o); process.exit(1); }
writeFileSync("data/landed/fx.json", JSON.stringify({ usdcad: rate, date: o.d, source: "Bank of Canada daily exchange rate (FXUSDCAD), updated by the daily scout" }, null, 1) + "\n");
console.log(`USD→CAD ${rate} on ${o.d}`);
