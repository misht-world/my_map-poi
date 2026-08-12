# my_map-poi

A free, static web map of **notable landmarks across Europe** — built entirely
from Wikidata, Wikipedia and Wikimedia Commons. No server, no database, no
manually curated list of places: which points appear, and how densely, is
decided by a **significance score**, not by hand.
https://misht-world.github.io/my_map-poi/

- Objects & metadata: [Wikidata](https://www.wikidata.org/) (CC0) — filtered by
  type (`P31`/`P279*` whitelist), so cities, roads and rivers never leak in as
  "landmarks".
- Text & photos: [Wikipedia](https://www.wikipedia.org/) summaries (CC BY-SA)
  and [Wikimedia Commons](https://commons.wikimedia.org/) images (photos are
  published only with author + license attribution).
- Basemap: [OpenFreeMap](https://openfreemap.org/) (free, keyless).
- Overlay: our own PMTiles, served same-origin from GitHub Pages.
- Frontend: MapLibre GL + PMTiles + OpenFreeMap (vanilla JS, no build step).

The map UI and card text are localized in **Russian** (native Russian labels and
summaries where available, offline machine translation otherwise).

## Maps

| Page | Region | Data delivery |
|---|---|---|
| [`/europe.html`](https://misht-world.github.io/my_map-poi/europe.html) | All of Europe (~515k objects) | Vector **PMTiles** (zoom-thinned) |
| [`/`](https://misht-world.github.io/my_map-poi/) | Pilot: Bolzano–Verona corridor | GeoJSON loaded directly |

## What works today

- Interactive Europe map, **6 categories** by colour (religion, fortress,
  museum, monument, nature, leisure); marker **size = significance**.
- **Significance slider** (score threshold by zoom) to thin out minor objects;
  three significance tiers reveal progressively as you zoom in.
- Per-feature card: photo + attribution, Wikipedia summary (Russian), original
  name with Russian name below, website, links to Wikipedia and Google Maps.
- Round photo thumbnails on the map for the most notable objects (lazy-loaded,
  CORS-clean Commons thumbnails).
- Category toggles, collapsible panel, geolocation, mobile bottom sheet.

## How significance is scored

Instead of curating a list, every object gets a score (pure function,
unit-tested, `src/score.mjs`):

```
score = w1·log(sitelinks + 1) + w2·log(pageviews_90d + 1) + w3·(has_image ? 1 : 0)
```

`sitelinks` (number of non-bot Wikipedia articles) is the backbone; pageviews
and a photo nudge it. The client filters by score per zoom level, so dense city
clusters stay readable and only the most notable objects survive at low zoom.

## Data sources

| Input | Used for |
|---|---|
| [Wikidata JSON dump](https://dumps.wikimedia.org/wikidatawiki/entities/) (~144 GB gz) | Objects, coordinates, type, labels, image/website claims. |
| [Wikipedia REST/Action API](https://www.mediawiki.org/wiki/API:Main_page) | Pageviews + intro summaries. |
| [Wikimedia Commons API](https://commons.wikimedia.org/w/api.php) | Photo thumbnails + author/license attribution. |
| [OpenFreeMap](https://openfreemap.org/) | Basemap vector tiles. |

All end-user data derives from Wikidata (CC0), Wikipedia (CC BY-SA) and
Wikimedia Commons (per-file licenses, shown in the card).

## Architecture (heavy pipeline runs on your PC, CI only tiles)

Unlike a Geofabrik extract, the Wikidata dump is far too large to process on a
GitHub runner, so the **data pipeline runs locally** and only the trivial
tiling + deploy runs in CI:

```
eu-00 download dump   → segmented, resumable download of latest-all.json.gz
eu-01 parse dump      → stream-parse 120M+ entities → type-filtered objects (JSONL)
eu-03 enrich          → pageviews + summaries + Commons photos (significant slice)
eu-04 translate       → offline MT of non-Russian summaries (argostranslate)
eu-02 normalize       → GeoJSONSeq + meta, applies score() and Russian-only text
      ── upload europe.geojsonseq.gz + europe.meta.json to the europe-src release ──
CI: tile-eu.yml       → tippecanoe → europe.pmtiles → europe-tiles release → deploy Pages
```

Everything is incremental and resumable (per-qid caches on disk), because a
full region is thousands of API calls and a multi-hour dump scan — re-running
one step must not recompute the rest.

## Run the site locally

```bash
npm install
npm test          # scoring unit tests (node --test)
npm run dev       # serves web/ at http://localhost:5173
```

The Europe map loads `europe.pmtiles`; for local dev it expects that file
next to the page (same-origin), mirroring how GitHub Pages serves it.

## Rebuild the data (optional, long)

Prerequisites: Node 20+, Python 3 with
[argostranslate](https://github.com/argosopentech/argos-translate) (+ language
models), [gh](https://cli.github.com/) authenticated, and ~200 GB free disk for
the dump.

```bash
# 1. Download + parse the Wikidata dump (hours; resumable)
npm run data:build-eu

# 2. Enrich the significant slice — pageviews, summaries, photos (hours)
npm run data:enrich-eu-full

# 3. Translate non-Russian summaries offline (hours; shardable: "-- 1/3", "2/3", …)
npm run data:translate-eu

# 4. Normalize → GeoJSONSeq + meta
npm run data:normalize-eu

# 5. Publish input to the release, then tile + deploy in CI
npm run data:publish-eu
gh workflow run tile-eu.yml
```

Step 5's `tile-eu.yml` builds the PMTiles and deploys GitHub Pages in one run
(the deploy job `needs:` the tile job, so the site is never deployed against a
stale tile). Steps 1–4 all print progress and are safe to Ctrl+C and resume.

## Automated builds

- **`.github/workflows/tile-eu.yml`** — manual (`workflow_dispatch`). Builds
  tippecanoe, tiles the uploaded GeoJSON into `europe.pmtiles`, publishes it to
  the `europe-tiles` release, then deploys Pages. PMTiles is served same-origin
  from Pages (GitHub Release assets have no CORS).
- **`.github/workflows/pages.yml`** — deploys the static site on every push to
  `web/`, `config/` or `data/normalized/`, pulling the latest PMTiles and meta
  from the releases.

One-time repo setup: **Settings → Pages → Source → GitHub Actions**.

## Project layout

```
config/           # poi-types.json (category whitelist/blacklist Q-ids), scoring.json, regions.json
src/score.mjs     # pure significance score, unit-tested
scripts/
  eu-00…eu-04     # Europe pipeline: download, parse, enrich, translate, normalize
  01…04 + *.py    # pilot (Bolzano–Verona) pipeline
web/
  europe.html     # Europe map (PMTiles)
  index.html      # pilot map (GeoJSON-direct)
docs/             # data licenses
SPEC.md           # full specification (Russian)
CLAUDE.md         # working notes / invariants (Russian)
```

## Design invariants

- **Type filter is mandatory.** Objects come only from Wikidata SPARQL/dump with
  a `P31`/`P279*` whitelist + blacklist (settlements, admin units). No "has
  coordinates + has sitelink" selection — that pollutes the map with cities and
  roads. Q-ids are verified in the Wikidata Query Service, never guessed.
- **No runtime API calls from the browser.** Score, photo, summary and
  attribution are baked into tile properties at build time.
- **No photo without attribution.** If author + license can't be resolved, the
  point is shown without a photo block.
- **Better empty than foreign.** Card text is shown only in Russian (native or
  translated); untranslatable foreign text is omitted, leaving the article link.

## License

Code: MIT. Rendered data: © Wikidata (CC0), Wikipedia (CC BY-SA), Wikimedia
Commons contributors (per-file licenses).
