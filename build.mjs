// Build script (esbuild only).
//   node build.mjs            -> dist/       static site for GitHub Pages (card images load from the official CDN)
//   node build.mjs --artifact -> dist-artifact/  single-page build with local card thumbnails
//   node build.mjs --serve    -> dev server on http://localhost:5173
import { build, context } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from "node:fs";

const artifact = process.argv.includes("--artifact");
const serve = process.argv.includes("--serve");
const out = artifact ? "dist-artifact" : "dist";
mkdirSync(out, { recursive: true });

const options = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: !serve,
  outfile: `${out}/app.js`,
  loader: { ".json": "json" },
  define: {
    __ARTIFACT__: String(artifact),
    __IMAGE_BASE__: JSON.stringify(artifact ? "cards/" : ""),
    // Supabase project for optional sign-in and sync (public values; the database is protected by row-level security)
    __SUPABASE_URL__: JSON.stringify(artifact ? "" : process.env.SUPABASE_URL ?? ""),
    __SUPABASE_ANON_KEY__: JSON.stringify(artifact ? "" : process.env.SUPABASE_ANON_KEY ?? ""),
  },
  logLevel: "info",
};

function writeHtml() {
  const html = readFileSync("index.html", "utf8");
  const css = readFileSync("src/styles.css", "utf8");
  if (!artifact) {
    writeFileSync(`${out}/index.html`, html);
    writeFileSync(`${out}/styles.css`, css);
    cpSync("public", out, { recursive: true });
    // price snapshots written by the scout (sample data is bundled separately)
    mkdirSync(`${out}/listings`, { recursive: true });
    for (const f of readdirSync("data/listings")) if (f.endsWith(".json") && f !== "sample.json") cpSync(`data/listings/${f}`, `${out}/listings/${f}`);
    mkdirSync(`${out}/grading`, { recursive: true });
    cpSync("data/grading/services.json", `${out}/grading/services.json`);
    mkdirSync(`${out}/galleries`, { recursive: true });
    cpSync("data/galleries/index.json", `${out}/galleries/index.json`);
    return;
  }
  // Artifact page: body content only, inline CSS and JS.
  const body = html.split("<!--APP-->")[1].split("<!--/APP-->")[0];
  const fonts = html.match(/<link rel="stylesheet" href="(https:\/\/fonts[^"]+)">/)?.[1];
  const js = readFileSync(`${out}/app.js`, "utf8");
  writeFileSync(`${out}/index.html`,
    `<title>SetKeeper</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n` +
    (fonts ? `<link rel="stylesheet" href="${fonts}">\n` : "") + `<style>\n${css}\n</style>\n${body}\n<script type="module">\n${js}\n</script>\n`);
  mkdirSync(`${out}/cards`, { recursive: true });
  const src = process.env.CARD_IMAGES ?? ".cache/images";
  if (existsSync(src)) for (const f of readdirSync(src)) if (/^2M6P_.*\.jpg$/.test(f)) cpSync(`${src}/${f}`, `${out}/cards/${f}`);
}

if (serve) {
  const ctx = await context(options);
  writeHtml();
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: out, port: 5173 });
  console.log(`SetKeeper running at http://localhost:${port}`);
} else {
  await build(options);
  writeHtml();
}
