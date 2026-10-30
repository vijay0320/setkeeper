# SetKeeper

A free, open-source web app for Pokémon TCG collectors. Track a set card by card, scan cards with your phone camera, check whether a price is fair, get a buy plan for your budget, and measure centering before you send cards for grading.

It covers **every English set**, from Base Set to whatever releases next, through the free [TCGdex](https://tcgdex.dev) card database (images, rarities and TCGplayer market prices). The **30th Celebration** set ships built in with its Classic Collection, energies and a ready-to-go scanner. Everything runs in the browser, and your collection stays on your device.

## Features

| | What it does |
|---|---|
| **Binder shelf** | A shelf of zip binders: one per set you collect (pick any set from the full list, grouped by series with logos) and any number of **personal binders** for your own picks from any set, like an Umbreon PC or a grails binder. Choose cover colour, leather / canvas / carbon, and 4, 9 or 12 pockets per page. |
| **Official galleries & new sets** | Every expansion on the official [Pokémon TCG card galleries](https://tcg.pokemon.com/en-us/all-galleries/) (Mega Evolution and Scarlet & Violet eras, including Black Bolt and White Flare as separate binders) is listed first when you add a set binder, with its card count and the official categories as binder sections: Special Art, Pokémon ex, Hyper Rare, ACE SPEC, Mega Evolution Pokémon and so on. Names, rarities and prices come from TCGdex. A daily scout checks the galleries; the day a new expansion's gallery goes live it appears on the shelf as "New set on the official gallery" with a one-tap binder, numbered from the gallery straight away, and names, prices and 3D card art fill in automatically once TCGdex adds the set. Every older set is still available from TCGdex. |
| **The binder** | A real zip binder rendered in WebGL. Pull the tab and the zipper runs around the cover (with zipper clicks), the cover swings open on its spine to a nameplate with your progress and a "Property of" line. Pages are side-loading sleeves: they bow as they turn, catch the light, cast a shadow on the page below and land with a soft thud. Drag a page by its edge to turn it at your own speed or flick it, use the arrows or keys, or jump to a section and the pages riffle past. Owned cards sit in colour; missing cards wait as ghosts with their number. Tap a pocket to open the card. Sound can be muted. "Zip it up" riffles back and closes the cover. A grid view is one tap away. Each card stores status, priority, copies, store and date seen, asking price, market value, what you paid and notes. |
| **Scan** | Take or upload photos (several at once). The app finds the card in the photo and matches it against fingerprints of the official card images, then shows the top three with a confidence score. Confirm to mark it owned. No upload, no account. |
| **Fair-price check** | Compares an asking price with market value in CAD: *Deal* (≤ 90 %), *Fair*, *Overpriced* (> 115 %), *Scalper price* (> 150 %). Thresholds are adjustable. A quick checker handles packs and boxes against MSRP, with USD → CAD conversion. |
| **Smart buy planner** | Give it a budget and it picks what to buy first: chase and high-priority cards, deals, cards in stock nearby, and cards that finish a section or rarity. Every pick says why. Overpriced asks are skipped unless you allow them. |
| **Best cart across sellers** | Compares in-stock singles from your shops and eBay and splits your missing cards across sellers so shipping doesn't eat the savings. It pushes orders over free-shipping lines with cards you need, holds back cheap cards that aren't worth shipping alone, and still buys a pricey card when it's worth it. Each order shows its subtotal, shipping, links and how much more unlocks free shipping. *Best value* or *Complete the set* mode, condition filter, Canadian-sellers-only toggle. |
| **Where to grade** | PSA, Beckett, CGC and TAG side by side: every service tier with its price (US$ and CA$), declared-value cap, turnaround, minimum order and whether it is open, limited or paused today. A daily scout re-checks the companies' pages and updates the list; when a paused tier opens up the app shows a "Just reopened" banner. |
| **Worth grading?** | Pick an owned card, say how it looks up close, and enter its raw value and slab sale prices per company (PSA 10/9, Beckett 9.5/9, CGC 10/9.5, TAG 10/9). It uses each company's cheapest open tier for the card's value, caps grade chances by measured centering under that company's rules, and compares expected profit against selling raw, naming the best company. A grading queue ranks every priced card. |
| **Packs vs singles** | Simulates opening packs from where your binder is now (one Pikachu, foils, an energy and a hit slot per pack) and prices whatever is still missing as singles. It finds the cheapest plan, e.g. "open about 8 packs, then buy singles", charts expected cost against packs opened, and counts duplicate hits at a resale share you choose. Pull odds are editable placeholders; the pack log records what you open, marks hits as owned and shows your own pull rates beside the odds. |
| **Centering grader** | Photograph a card; guides snap to the card edge and the inner frame (drag to adjust). Shows left/right and top/bottom ratios and the best PSA, BGS and CGC grade centering alone allows. Save the result to the card. |
| **Stats & insights** | Completion by section and rarity, money spent, cost to finish, spares for trading, and plain-language notes such as "2 away from every Double Rare (ex)". |
| **Import / export** | Imports a tracker spreadsheet (.xlsx or a Google Sheets CSV) by matching section and card number. Exports CSV for Google Sheets and a JSON backup. |

## How the AI parts work

**Card recognition** is a computer-vision matcher, not a cloud model. Each official card image is reduced to a fingerprint: two 64-bit perceptual hashes (DCT of the art box and of the whole card), a normalised 12×16 grayscale thumbnail and a hue/saturation histogram. A photo is fingerprinted at a few framings and ranked by a weighted similarity. Fingerprints for the set ship with the app (`data/sets/*.fingerprints.json`, 145 KB), so scanning works offline.

Measured with `npm run eval:scanner` on 564 simulated phone photos (±5° rotation, loose/tight framing, white-balance and brightness shifts, blur, glare, JPEG compression): **98.4 % top-1, 99.6 % top-3**, about 180 ms per scan. Real photos with sleeves, holo glare or steep angles will do worse, which is why you confirm the match.

**Centering** finds the card edge as the first strong colour transition in from each side, then walks inward along ~40 scanlines per side until the colour leaves the frame colour, taking the median. On simulated miscuts (`npm run eval:centering`) the left/right ratio tracks the true shift within **±1.7 points** on 240 px-wide images; higher-resolution photos do better. Full-art cards have no inner frame, so check the guides by eye.

**The cart optimizer** maximises surplus: the worth of the cards you get minus everything you pay, shipping included. A card's worth is its market value × your tolerance (115 % by default, higher for chase and high-priority cards), or its cheapest ask when you haven't entered a market value. So fifteen $0.50 cards behind $20 of shipping are deferred, a $150 card ships even with $5 shipping, and cheap cards join an order when they push it over a free-shipping line. It searches with three kinds of moves (move one card, close a seller, fill an order to its free-shipping line) from several starting carts. Against exhaustive search on 120 random small markets it found the optimum in 118 and was never more than $0.30 off; 70 cards across 12 sellers takes about 0.1 s.

**Packs vs singles** runs 900 simulated pack-opening runs per estimate and averages the cost of the cards still missing after each pack. The odds are guesses until replaced with published pull rates or your own log, so treat the answer as a direction, not a promise.

**Worth grading?** starts from base grade odds for three condition levels (pack fresh, minor flaws, visible wear), moves any PSA 10 chance down to 9 when centering can't make a 10 (and 9 down when it can't make a 9), and compares the expected sale value with the raw value plus fees.

**The budget planner** is a greedy value-per-dollar optimiser: value = priority weight × deal bonus × in-store bonus, plus a bonus when a pick completes a section or rarity. It re-scores after every pick.

## Quick start

```bash
git clone https://github.com/<you>/setkeeper.git
cd setkeeper
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (node:test)
npm run build      # static site in dist/
```

Requires Node 22.18 or newer (TypeScript runs natively, no transpile step for tests and scripts).

### Price data

The Buy tab needs listings. Three ways to get them:

1. **Price scout (automatic).** The daily GitHub Action collects in-stock Pokémon singles from every English set, from Shopify card shops that allow it (checked by `scripts/shop-audit.ts`: robots.txt and terms of service) and, with API keys, eBay. Listings are matched to cards by number and name using the full TCGdex card list (`src/lib/cardmatch.ts`) and saved as one snapshot per set; shops' sold-out cards are kept as markers so the app can say "sold out" instead of guessing. Put your shop list (same format as `data/sellers.example.json`) in the repo secret `SCOUT_SELLERS`, and the Supabase service-role key in the secret `SUPABASE_SERVICE_ROLE_KEY`. Each day's prices are stored in a private Supabase table; the price history is never committed to this public repo, and signed-in users can read only the newest prices. Run `node scripts/scout.ts` locally to write `data/listings/<set>.json` (git-ignored) instead.
2. **Listings sheet.** Import a CSV or .xlsx on the Data tab with columns Seller, Card #, Price, Qty, Condition, Printing, Shipping, Free over, Currency, URL.
3. **Sample data.** Fictional sellers and prices, to see how it works.

The scout's adapters are tested against recorded response formats (`npm test`), not against live shops. Check each shop's terms before scraping it; the scout reads public catalogue pages once a day with a delay between requests.

### Deploy to GitHub Pages

Push to `main`. The included workflow (`.github/workflows/pages.yml`) runs the tests, builds `dist/` and publishes it. In the repo settings, set **Pages → Source** to **GitHub Actions** once.

## Fair prices: printing × condition

A card's price depends on its **printing** (Normal, Holofoil, Reverse Holofoil, 1st Edition… are different products) and its **condition** (NM, LP, MP, HP, DMG), so SetKeeper never compares a played reverse holo with a Near Mint holo.

- **Every printing is priced separately.** TCGdex gives TCGplayer prices per printing (low, mid, market, high) and Cardmarket's price plus its reverse-holo price. The card sheet has a printing and condition picker; shop listings say which printing they are ("Lightly Played Reverse Holofoil"), and the cart only matches a want with listings of the same printing.
- **A fair value with its range, never a lone number.** Sources disagree (TCGplayer market runs about 20% above eBay sold and Cardmarket), so the fair Near Mint value is the mean of TCGplayer market (USD→CAD) and Cardmarket's trend / 30-day average (EUR→CAD, both at the Bank of Canada rate), shown with the range and each source. When the sources are more than 35% apart the sheet says so and points to eBay sold listings. TCGplayer's "low" (cheapest listing in any condition) is recorded but never used as a value.
- **Conditions are a share of Near Mint.** The free sources only price NM. Other conditions start as labelled estimates (LP 85%, MP 70%, HP 50%, DMG 35%) and switch to shares measured from Canadian shops that list the same card and printing in NM and a played condition: the daily scout records only the aggregate ratios, by card value, in `data/prices/conditions.json` (used from 8 pairs; last 30 days). Collectors can set their own on the Data tab.
- **Every listing is judged in its own condition.** In the Buy tab an LP copy is worth the LP value, so a heavily played card at 70% of the NM price is a bad buy, not a deal.
- **Price history** (`scripts/price-history.ts`, daily): one private row per card, printing and day with every figure above (`card_prices` in `supabase/setup.sql`). Signed-in collectors see a card's 90-day fair value with the sources' range shaded, and the cost to finish their set over time.

## Landed cost (Canada)

The Buy tab compares sellers on what an order costs **at your door**, not the sticker price: shops' GST/HST and PST for your province, the Bank of Canada USD→CAD rate (refreshed daily), your card's foreign-exchange fee, and for imports the CA$20 mail and CA$40 US-courier tax limits, GST/HST plus provincial tax collected at the border (BC, MB, QC, SK), and Canada Post's handling fee or a courier's brokerage fee. Trading cards (tariff item 9504.40.00) are duty-free and aren't on Canada's 2026 surtax list for US goods. The cart optimizer minimises this landed total, so a cheaper US listing loses when border tax and fees make it dearer. Rules and sources live in `data/landed/rules.json`; sellers can set `province`, `taxAt` (`checkout`/`border`) and `carrier` (`post`/`courier`) in the shop list.

## Sync and backup

Everything is saved in the browser first, so the app works offline and without an account. **Data → Sync & backup** adds:

- **Backup file:** one JSON file with your binders and card data; restore it on any device.
- **Sign-in and sync (optional):** sign in with an emailed link (no password) and your data syncs between devices through [Supabase](https://supabase.com). Each collector's data is one row in a Postgres table protected by row-level security, so nobody else can read it. Only your own data is uploaded; card databases and caches stay on the device. When the same thing is edited on two devices, the most recent change wins.

To turn sync on for your deployment:

1. Create a free project at supabase.com (pick a Canadian region if you're in Canada).
2. **SQL Editor → New query**, paste `supabase/setup.sql`, **Run**.
3. **Authentication → URL Configuration:** set Site URL to your site (e.g. `https://you.github.io/setkeeper/`) and add it under Redirect URLs.
4. **Project Settings → API:** copy the Project URL and the `anon` public key into the GitHub repo under **Settings → Secrets and variables → Actions → Variables** as `SUPABASE_URL` and `SUPABASE_ANON_KEY`, then re-run the deploy.

The anon key is meant to be public; row-level security is what protects the data. The daily scout calls a `keepalive` function so a free project isn't paused for inactivity. Supabase's built-in email sender allows only a few sign-in emails an hour; for more users, add your own SMTP under Authentication → Emails.

## Sets

**Daily scout.** `.github/workflows/scout.yml` runs `scripts/gallery-scout.ts` every day: it reads tcg.pokemon.com/en-us/all-galleries/, each gallery page and its `cards.json`, matches each set to TCGdex by name, updates `data/galleries/index.json` and redeploys. tcg.pokemon.com has a bot check, so if plain requests are challenged the scout loads the pages in headless Chromium (Playwright). Run it yourself with `npm run gallery-scout`.

Any set can be added from the shelf. The app loads its card list from TCGdex, then fetches rarity and TCGplayer market prices for every card in the background (about 2–3 seconds for a 240-card set) and caches them for three days. Market prices fill in wherever you haven't typed your own, so the planner, cart optimizer, packs and grading tools work straight away. The first time you scan a new set, the app downloads its card images once and learns their fingerprints on your device.

To bundle a set like 30th Celebration (works offline, curated sections), add `data/sets/<set-id>.json` and run `npm run fingerprints -- <set-id>`. That script and the two `eval:` scripts need the image library sharp, which isn't installed by default: run `npm i --no-save sharp@latest` first.

## Project layout

```
src/
  main.ts            UI (no framework)
  styles.css
  lib/               types, storage, pricing, planner, xlsx/CSV import & export
  vision/            fingerprints, matcher, centering detector, browser helpers
data/sets/           set lists and precomputed fingerprints
data/listings/       price snapshots (scout output) and fictional sample data
scripts/             fingerprint builder, accuracy evaluations, price scout (scripts/scout*)
test/                unit tests
```

## Privacy

No accounts, no tracking, no server. Your collection is saved in your browser's local storage; export a backup to move it to another device.

## Roadmap

- Optional learned embeddings (CLIP via transformers.js) for harder photos and new sets without precomputing
- Market values filled in automatically from sold listings
- Sync between devices
- More sets

## Disclaimer


Unofficial fan project, not affiliated with or endorsed by The Pokémon Company, Nintendo, Creatures or Game Freak. Card names and images are © their owners; the app displays images from the official card gallery and does not redistribute them. Centering estimates are a guide, not a grade.

## License

MIT
