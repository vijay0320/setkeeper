// Resolve sharp from the project or a global install.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const require = createRequire(import.meta.url);
export function loadSharp(): any {
  try { return require("sharp"); } catch {
    const root = execSync("npm root -g").toString().trim();
    return require(`${root}/sharp`);
  }
}
