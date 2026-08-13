// ЕВРОПА, рефреш без дампа: текущий набор объектов через Wikidata SPARQL + wbgetentities.
//
// Заменяет одноразовую холодную сборку из 144ГБ дампа (eu-00/eu-01) для РЕГУЛЯРНЫХ обновлений.
// Даёт europe.parsed.jsonl той же схемы, что и парсер дампа, — дальше пайплайн (enrich →
// translate → normalize → tile) не меняется. За квартал добавляется несколько тысяч объектов,
// не 515k; enrich/translate инкрементальны (кэш поштучный), платим только за новое.
//
// Два прохода:
//   1) SPARQL-сетка по bbox (SERVICE wikibase:box на клетку) с whitelist/blacklist из
//      config/poi-types.json → qid + coords + категория(по catRank) + image(P18) + website + ru-label.
//      Плотная клетка (таймаут WDQS) рекурсивно дробится на 4. Клетки кэшируются (резюмируемо).
//   2) wbgetentities (батч 50) добирает sitelinks (точный non-bot счётчик + primary wiki_lang/title
//      + ru_title) и label/description — то, что в SPARQL дорого. Кэш по qid.
//
// Запуск:
//   node scripts/eu-05-refresh.mjs --bbox 11.05,46.02,11.18,46.10   # ОДНА клетка (проверка)
//   node scripts/eu-05-refresh.mjs --region europe                  # вся Европа (сетка)
//   node scripts/eu-05-refresh.mjs --region europe --cell 1.0       # размер клетки, град.
//
// Итог: data/eu/europe.parsed.jsonl (+ .refresh-diff.json со статистикой добавл./удал.).

import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'my_map-poi/0.0 (https://github.com/misht-world/my_map-poi; misht.world@gmail.com)';
const WDQS = 'https://query.wikidata.org/sparql';
const WBAPI = 'https://www.wikidata.org/w/api.php';

// Схема sitelinks — та же, что в парсере дампа (eu-01), чтобы счётчик/выбор статьи совпадали.
const BOT_WIKIS = new Set(['cebwiki', 'warwiki']);
const NON_WIKIPEDIA_KEYS = new Set([
  'commonswiki', 'specieswiki', 'metawiki', 'wikidatawiki', 'mediawikiwiki',
  'incubatorwiki', 'sourceswiki', 'foundationwiki', 'outreachwiki', 'wikimaniawiki',
]);
const LANG_PREFERENCE = ['it', 'de', 'en', 'fr', 'es', 'pt', 'nl', 'pl', 'cs', 'ro',
  'sv', 'uk', 'ja', 'ca', 'fi', 'da', 'hu', 'el', 'tr', 'sl', 'sk'];
const isRealWiki = (k) => k.endsWith('wiki') && !NON_WIKIPEDIA_KEYS.has(k) && !BOT_WIKIS.has(k);
function chooseWiki(sitelinks) {
  for (const lang of LANG_PREFERENCE) { const k = `${lang}wiki`; if (sitelinks[k]) return { lang, title: sitelinks[k].title }; }
  for (const k of Object.keys(sitelinks)) if (isRealWiki(k)) return { lang: k.replace(/wiki$/, ''), title: sitelinks[k].title };
  return null;
}
function firstLabel(labels) {
  for (const lang of ['it', 'de', 'en', ...LANG_PREFERENCE]) if (labels[lang]) return labels[lang].value;
  const any = Object.values(labels)[0];
  return any ? any.value : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
async function mapLimit(items, limit, fn) {
  let i = 0; const out = new Array(items.length);
  const work = async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, work));
  return out;
}

async function getJson(url, { retries = 5, headers = {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } }); }
    catch (e) { if (attempt >= retries) throw e; await sleep(Math.min(1000 * 2 ** attempt, 30000)); continue; }
    if (res.ok) return res.json();
    if ((res.status !== 429 && res.status < 500) || attempt >= retries) throw new Error(`HTTP ${res.status}`);
    await sleep(Number(res.headers.get('retry-after')) * 1000 || Math.min(1000 * 2 ** attempt, 30000));
  }
}

// --- SPARQL по клетке ----------------------------------------------------------

function buildCellQuery(roots, blacklist, [w, s, e, n]) {
  const rootsV = roots.map((q) => `wd:${q}`).join(' ');
  const blV = blacklist.map((q) => `wd:${q}`).join(' ');
  return `SELECT ?item ?lat ?lon ?w ?sitelinks ?image ?website ?ruLabel WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerWest "Point(${w} ${s})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerEast "Point(${e} ${n})"^^geo:wktLiteral .
  }
  ?item p:P625/psv:P625 ?cn . ?cn wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lon .
  ?item wdt:P31 ?t . ?t wdt:P279* ?w . VALUES ?w { ${rootsV} }
  FILTER NOT EXISTS { ?item wdt:P31 ?bt . ?bt wdt:P279* ?bl . VALUES ?bl { ${blV} } }
  OPTIONAL { ?item wikibase:sitelinks ?sitelinks. }
  OPTIONAL { ?item wdt:P18 ?image. }
  OPTIONAL { ?item wdt:P856 ?website. }
  OPTIONAL { ?item rdfs:label ?ruLabel. FILTER(LANG(?ruLabel)="ru") }
}`;
}

async function sparqlCell(roots, blacklist, box) {
  const q = buildCellQuery(roots, blacklist, box);
  const url = `${WDQS}?query=${encodeURIComponent(q)}&format=json`;
  const j = await getJson(url, { headers: { Accept: 'application/sparql-results+json' }, retries: 2 });
  const items = new Map();
  for (const r of j.results.bindings) {
    const qid = r.item.value.split('/').pop();
    if (!items.has(qid)) items.set(qid, {
      qid, lat: +r.lat.value, lon: +r.lon.value,
      image: r.image ? decodeURIComponent(r.image.value.split('/').pop()).replace(/_/g, ' ') : null,
      website: r.website?.value || null, label_ru: r.ruLabel?.value || null, roots: [],
    });
    items.get(qid).roots.push(r.w.value.split('/').pop());
  }
  return [...items.values()];
}

// Рекурсивно: если клетка падает/таймаутит — дробим на 4, пока не MIN_CELL.
async function fetchGrid(roots, blacklist, box, cell, cacheDir, log) {
  const [w, s, e, n] = box;
  const key = `${w.toFixed(3)}_${s.toFixed(3)}_${e.toFixed(3)}_${n.toFixed(3)}`;
  const cacheF = resolve(cacheDir, `cell_${key}.json`);
  if (existsSync(cacheF)) return JSON.parse(readFileSync(cacheF, 'utf8'));

  const MIN_CELL = 0.125;
  try {
    const rows = await sparqlCell(roots, blacklist, box);
    writeFileSync(cacheF, JSON.stringify(rows));
    log(`  cell ${key}: ${rows.length}`);
    await sleep(300);
    return rows;
  } catch (err) {
    if ((e - w) <= MIN_CELL) { log(`  cell ${key}: FAIL (${err.message}) — пропуск (клетка уже минимальна)`); return []; }
    log(`  cell ${key}: ${err.message} → дроблю на 4`);
    const mx = (w + e) / 2, my = (s + n) / 2;
    const quads = [[w, s, mx, my], [mx, s, e, my], [w, my, mx, n], [mx, my, e, n]];
    let all = [];
    for (const q of quads) all = all.concat(await fetchGrid(roots, blacklist, q, cell, cacheDir, log));
    return all;
  }
}

// --- wbgetentities: sitelinks + label/description -------------------------------

async function hydrate(qids, cache, save, log) {
  const todo = qids.filter((q) => !cache.has(q));
  const langs = [...new Set([...LANG_PREFERENCE, 'ru'])].join('|');
  const batches = chunk(todo, 50);
  let done = 0;
  for (const b of batches) {
    const url = `${WBAPI}?action=wbgetentities&ids=${b.join('|')}&props=labels|descriptions|sitelinks&languages=${langs}&format=json&origin=*`;
    const j = await getJson(url).catch(() => null);
    const ents = j?.entities || {};
    for (const q of b) {
      const en = ents[q];
      if (!en || en.missing !== undefined) { cache.set(q, null); continue; }
      const sitelinks = en.sitelinks || {};
      let slCount = 0; for (const k of Object.keys(sitelinks)) if (isRealWiki(k)) slCount++;
      const wiki = chooseWiki(sitelinks);
      const labels = en.labels || {};
      cache.set(q, {
        sitelinks_count: slCount,
        wiki_lang: wiki?.lang || null,
        wiki_title: wiki?.title || null,
        ru_title: sitelinks.ruwiki?.title || null,
        label: (wiki && labels[wiki.lang]?.value) || firstLabel(labels),
        label_ru: labels.ru?.value || null,
        description_ru: en.descriptions?.ru?.value || null,
      });
    }
    done += b.length;
    if (done % 500 === 0 || done === todo.length) { process.stdout.write(`\r  hydrate ${done}/${todo.length}`); save(); }
    await sleep(120);
  }
  if (todo.length) process.stdout.write('\n');
  save();
}

// --- main ----------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : d; };
  const region = arg('--region', 'europe');
  const cell = Number(arg('--cell', 1.0));
  const conc = Number(arg('--conc', 4)); // параллельных SPARQL-клеток
  const bboxArg = arg('--bbox', null); // тест одной клетки: W,S,E,N
  const limit = argv.includes('--limit') ? Number(arg('--limit')) : Infinity;
  const now = new Date();
  const quarter = `${now.getFullYear()}Q${Math.floor(now.getMonth() / 3) + 1}`;

  const poiTypes = JSON.parse(readFileSync(resolve(ROOT, 'config/poi-types.json'), 'utf8'));
  const regions = JSON.parse(readFileSync(resolve(ROOT, 'config/regions.json'), 'utf8'));
  const cats = Object.keys(poiTypes.categories);
  const catRank = Object.fromEntries(cats.map((c, i) => [c, i])); // порядок ключей = приоритет
  const rootToCat = {};
  for (const c of cats) for (const q of Object.keys(poiTypes.categories[c].roots)) rootToCat[q] = c;
  const roots = Object.keys(rootToCat);
  const blacklist = Object.keys(poiTypes.blacklist);

  const refreshDir = resolve(ROOT, `data/eu/refresh`);
  // Кэш клеток — поквартальный: новый квартал стартует свежим, внутри квартала резюмируем.
  const cellDir = resolve(refreshDir, `cells-${quarter}`);
  mkdirSync(cellDir, { recursive: true });
  const log = (m) => console.log(m);

  // 1) SPARQL-набор
  let rows;
  if (bboxArg) {
    const box = bboxArg.split(',').map(Number);
    log(`SPARQL одна клетка ${bboxArg}…`);
    rows = await fetchGrid(roots, blacklist, box, cell, cellDir, log);
  } else {
    const rb = regions.regions?.[region]?.bbox || regions[region]?.bbox || regions.bbox;
    const b = rb.west !== undefined ? [rb.west, rb.south, rb.east, rb.north] : rb;
    const cells = [];
    for (let x = b[0]; x < b[2]; x += cell)
      for (let y = b[1]; y < b[3]; y += cell)
        cells.push([x, y, Math.min(x + cell, b[2]), Math.min(y + cell, b[3])]);
    log(`SPARQL-сетка ${region} bbox=[${b}] клетка ${cell}° — ${cells.length} клеток, параллельно ${conc}…`);
    const parts = await mapLimit(cells, conc, (box) => fetchGrid(roots, blacklist, box, cell, cellDir, log));
    rows = parts.flat();
  }

  // дедуп по qid + категория по catRank
  const byQid = new Map();
  for (const r of rows) {
    const prev = byQid.get(r.qid);
    if (prev) { prev.roots = [...new Set([...prev.roots, ...r.roots])]; continue; }
    byQid.set(r.qid, r);
  }
  for (const r of byQid.values()) {
    let best = Infinity, cat = null;
    for (const root of r.roots) { const c = rootToCat[root]; if (c && catRank[c] < best) { best = catRank[c]; cat = c; } }
    r.category = cat;
  }
  const objs = [...byQid.values()].filter((r) => r.category);
  log(`\nSPARQL: ${objs.length} объектов (уникальных, с категорией)`);

  // 2) wbgetentities-добор
  const hCacheF = resolve(refreshDir, `entities.json`);
  const hCache = existsSync(hCacheF) ? new Map(JSON.parse(readFileSync(hCacheF, 'utf8'))) : new Map();
  const saveH = () => writeFileSync(hCacheF, JSON.stringify([...hCache]));
  const list = Number.isFinite(limit) ? objs.slice(0, limit) : objs;
  log(`wbgetentities для ${list.length}…`);
  await hydrate(list.map((r) => r.qid), hCache, saveH, log);

  // сборка записей в схеме парсера дампа, фильтр «есть ≥1 не-бот вики-статья»
  const out = [];
  for (const r of list) {
    const h = hCache.get(r.qid);
    if (!h || h.sitelinks_count < 1) continue; // как в eu-01: без значимой статьи не берём
    out.push({
      qid: r.qid, lat: r.lat, lon: r.lon,
      sitelinks_count: h.sitelinks_count, category: r.category,
      label: h.label || r.label_ru || r.qid,
      label_ru: h.label_ru || r.label_ru || null,
      description_ru: h.description_ru || null,
      image: r.image || null, website: r.website || null,
      wiki_lang: h.wiki_lang, wiki_title: h.wiki_title, ru_title: h.ru_title,
    });
  }
  log(`Годных (sitelinks>=1): ${out.length}`);

  // дифф со старым parsed.jsonl
  const parsedF = resolve(ROOT, `data/eu/${region}.parsed.jsonl`);
  const oldQids = new Set();
  if (existsSync(parsedF) && !bboxArg) {
    const rl = createInterface({ input: createReadStream(parsedF), crlfDelay: Infinity });
    for await (const line of rl) { if (!line) continue; try { oldQids.add(JSON.parse(line).qid); } catch {} }
  }
  const newQids = new Set(out.map((r) => r.qid));
  const added = [...newQids].filter((q) => !oldQids.has(q)).length;
  const removed = [...oldQids].filter((q) => !newQids.has(q)).length;

  if (bboxArg) {
    // тестовый режим — НЕ перезаписываем боевой parsed.jsonl, только показываем
    writeFileSync(resolve(refreshDir, 'test-cell.parsed.jsonl'), out.map((r) => JSON.stringify(r)).join('\n'));
    log(`\n[тест] записано ${out.length} в data/eu/refresh/test-cell.parsed.jsonl`);
    log(`[тест] пример: ${JSON.stringify(out[0])}`);
  } else {
    if (existsSync(parsedF)) renameSync(parsedF, parsedF + '.prev');
    writeFileSync(parsedF, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(resolve(ROOT, `data/eu/${region}.refresh-diff.json`),
      JSON.stringify({ built: new Date().toISOString().slice(0, 10), total: out.length, added, removed }, null, 1));
    log(`\nЗаписано data/eu/${region}.parsed.jsonl: ${out.length} (было ${oldQids.size}); +${added} / -${removed}`);
    log(`Дальше: npm run data:enrich-eu-full → data:translate-eu → data:normalize-eu → data:publish-eu → tile-eu`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('\n' + (e.stack || e.message)); process.exit(1); });
}
