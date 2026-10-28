// sharp (image processing) is only needed by the maintainer scripts that precompute
// fingerprints and run the scanner / centering evaluations. It isn't a dependency of the
// app, its tests or its build, so a vulnerable native image library never ships or runs
// in CI. Install the latest version only when you run those scripts:
//   npm i --no-save sharp@latest
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const require = createRequire(import.meta.url);
export function loadSharp(): any {
  try { return require("sharp"); } catch { /* try a global install */ }
  try { return require(`${execSync("npm root -g").toString().trim()}/sharp`); } catch { /* not installed */ }
  console.error("This script needs sharp. Install it with:  npm i --no-save sharp@latest");
  process.exit(1);
}
