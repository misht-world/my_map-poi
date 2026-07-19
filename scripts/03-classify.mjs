// 03 — Классификация POI по категориям (config/poi-types.json → categories).
//
// Для каждого qid определяет ОДНУ категорию по P31/P279*: объект относится к категории,
// если достигает любого её корневого класса. При совпадении нескольких — берётся первая
// по порядку категорий в конфиге (religion > fortress > museum > monument > nature > leisure).
// Категория задаёт цвет маркера; is_religious (для фильтра церквей) = category==='religion'.
//
// Результат: data/enrich/<region>.categories.json = { qid: category }. Инкрементально:
// классифицируются только отсутствующие qid (расширение whitelist не гонит всё заново).
//
// Запуск: node scripts/03-classify.mjs [--region name] [--force]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA =
  'my_map-poi/0.0 (https://github.com/misht-world/my_map-poi; misht.world@gmail.com) node-fetch';

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSparql(query, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Accept: 'application/sparql-results+json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ query }),
    });
    if (res.ok) return res.json();
    if ((res.status !== 429 && res.status < 500) || attempt >= retries) {
      throw new Error(`SPARQL ${res.status} ${res.statusText}`);
    }
    await sleep(Number(res.headers.get('retry-after')) * 1000 || 2000 * (attempt + 1));
  }
}

/**
 * qid[] → Map qid → category. Один запрос на батч возвращает пары (item, root),
 * категория выбирается по приоритету (порядок категорий в конфиге).
 */
export async function classify(qids, categories) {
  const catOrder = Object.keys(categories); // приоритет
  const rootToCat = {};
  for (const [cat, def] of Object.entries(categories)) {
    for (const qid of Object.keys(def.roots)) rootToCat[qid] = cat;
  }
  const allRoots = Object.keys(rootToCat).map((q) => `wd:${q}`).join(' ');
  const catRank = Object.fromEntries(catOrder.map((c, i) => [c, i]));

  const result = new Map();
  const batches = chunk(qids, 200);
  for (const [bi, batch] of batches.entries()) {
    const values = batch.map((q) => `wd:${q}`).join(' ');
    const query =
      `SELECT ?item ?root WHERE { VALUES ?item { ${values} } ` +
      `?item wdt:P31/wdt:P279* ?root . VALUES ?root { ${allRoots} } }`;
    const j = await runSparql(query);
    // qid → лучшая (минимальный ранг) категория
    const best = new Map();
    for (const b of j.results.bindings) {
      const qid = b.item.value.split('/').pop();
      const cat = rootToCat[b.root.value.split('/').pop()];
      if (!cat) continue;
      if (!best.has(qid) || catRank[cat] < catRank[best.get(qid)]) best.set(qid, cat);
    }
    for (const [qid, cat] of best) result.set(qid, cat);
    process.stdout.write(`\r  classify: батч ${bi + 1}/${batches.length}   `);
    await sleep(300);
  }
  process.stdout.write('\n');
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  const regions = JSON.parse(readFileSync(resolve(ROOT, 'config/regions.json'), 'utf8'));
  const poiTypes = JSON.parse(readFileSync(resolve(ROOT, 'config/poi-types.json'), 'utf8'));
  const force = argv.includes('--force');
  const ri = argv.indexOf('--region');
  const name = ri !== -1 && argv[ri + 1] && !argv[ri + 1].startsWith('--') ? argv[ri + 1] : regions.default;

  const src = resolve(ROOT, `data/enrich/${name}.enriched.json`);
  if (!existsSync(src)) throw new Error(`Нет ${src} — сначала шаг 3 (02-enrich)`);
  const qids = JSON.parse(readFileSync(src, 'utf8')).map((i) => i.qid);

  const outFile = resolve(ROOT, `data/enrich/${name}.categories.json`);
  const existing = !force && existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : {};
  const missing = qids.filter((q) => !(q in existing));
  if (!missing.length) {
    console.log(`Категории из кэша: ${Object.keys(existing).length}`);
    return;
  }

  console.log(`Классифицирую ${missing.length} объектов (${Object.keys(existing).length} из кэша)…`);
  const cats = await classify(missing, poiTypes.categories);
  for (const [qid, cat] of cats) existing[qid] = cat;

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(existing));

  const counts = {};
  for (const c of Object.values(existing)) counts[c] = (counts[c] ?? 0) + 1;
  console.log('Категории:', counts);
  console.log(`Сохранено: data/enrich/${name}.categories.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('\n' + e.message);
    process.exit(1);
  });
}
