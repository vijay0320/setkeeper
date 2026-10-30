// Works out which card a shop or eBay listing title refers to.
import type { CardSet } from "../../src/lib/types.ts";

const EXCLUDE = /\b(psa|bgs|cgc|tag|ace|graded|slab|proxy|custom|orica|replica|fake|japanese|jpn|korean|chinese|lot of|bundle|empty|code card|online code|booster|etb|elite trainer|tin|box|pack)\b/i;
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9♀♂ ]/g, " ").replace(/\s+/g, " ").trim();

/** `inSetCollection`: the listing comes from a shop's collection for this set, so its title needn't name the set. */
export function matchTitle(title: string, set: CardSet, inSetCollection = false): string | undefined {
  if (EXCLUDE.test(title)) return undefined;
  if (!inSetCollection && !/30th|celebration/i.test(title)) return undefined;
  const t = norm(title);
  const classic = /classic/i.test(title);

  // RGB Mew: "Mew R/RGB", "Mew (Red) RGB"
  const rgb = title.match(/\b([RGB])\s*\/\s*RGB\b/i) ?? title.match(/\bRGB\b.*\b(red|green|blue)\b|\b(red|green|blue)\b.*\bRGB\b/i);
  if (rgb && /mew/i.test(title)) {
    const c = (rgb[1] ?? rgb[2] ?? rgb[3] ?? "").toLowerCase()[0];
    return set.cards.find((x) => x.id === `mew-${c}`)?.id;
  }

  for (const m of title.matchAll(/\b(\d{1,3})\s*\/\s*(\d{2,3})\b/g)) {
    const [num, of] = [Number(m[1]), Number(m[2])];
    const candidates = set.cards.filter((c) => {
      const [a, b] = c.number.split("/");
      return Number(a) === num && Number(b) === of && (c.section === "Classic Collection") === (classic || of !== 128);
    });
    // the card name must appear in the title (guards against "4/102" from other sets)
    const named = candidates.filter((c) => norm(c.name.replace(/\(.*\)/, "")).split(" ").filter((w) => w.length > 1 && !["ex", "gx", "v"].includes(w)).every((w) => t.includes(w)));
    if (named.length === 1) return named[0].id;
  }
  return undefined;
}
