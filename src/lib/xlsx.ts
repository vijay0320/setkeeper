// Minimal .xlsx reader (no dependencies): unzips with DecompressionStream and reads
// cell values from the worksheet XML. Enough to import a tracker spreadsheet.

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const b = new Uint8Array(buf);
  const v = new DataView(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--)
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Not a zip / .xlsx file");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = v.getUint16(local + 26, true), lExtra = v.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtra;
    const raw = b.subarray(start, start + csize);
    if (/\.(xml|rels)$/.test(name)) files.set(name, method === 8 ? await inflateRaw(raw) : raw.slice());
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)![0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export type Cell = string | number | null;
export interface Sheet { name: string; rows: Cell[][] }

export async function readXlsx(buf: ArrayBuffer): Promise<Sheet[]> {
  const files = await unzip(buf);
  const dec = new TextDecoder();
  const text = (n: string) => (files.has(n) ? dec.decode(files.get(n)!) : "");
  const shared: string[] = [];
  for (const si of text("xl/sharedStrings.xml").match(/<si>[\s\S]*?<\/si>/g) ?? [])
    shared.push(unescape((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")));
  const wb = text("xl/workbook.xml");
  const rels = text("xl/_rels/workbook.xml.rels");
  const sheets: Sheet[] = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const target = rels.match(new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${m[2]}"`));
    const path = "xl/" + (target?.[1] ?? target?.[2] ?? "").replace(/^\/?xl\//, "");
    const xml = text(path);
    const rows: Cell[][] = [];
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
      const r = Number(row.match(/<row\b[^>]*\br="(\d+)"/)?.[1] ?? rows.length + 1) - 1;
      const cells: Cell[] = [];
      for (const c of row.match(/<c\b[^>]*?(\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const ref = c.match(/\br="([A-Z]+\d+)"/)?.[1];
        if (!ref) continue;
        const t = c.match(/\bt="(\w+)"/)?.[1];
        const val = c.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const inline = c.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/)?.[1];
        let out: Cell = null;
        if (t === "s" && val != null) out = shared[Number(val)] ?? null;
        else if (t === "inlineStr" && inline != null) out = unescape(inline);
        else if (t === "str" && val != null) out = unescape(val);
        else if (val != null) out = Number.isFinite(Number(val)) ? Number(val) : unescape(val);
        cells[colIndex(ref)] = out;
      }
      rows[r] = cells;
    }
    sheets.push({ name: unescape(m[1]), rows: Array.from(rows, (r) => r ?? []) });
  }
  return sheets;
}

/** Excel serial date → ISO yyyy-mm-dd */
export function excelDate(n: number): string {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
  return d.toISOString().slice(0, 10);
}
