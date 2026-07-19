// Дотягивает официальный сайт объекта (Wikidata P856) для пилота (SPARQL-батч).
// Для Европы P856 будет браться прямо из дампа — этот скрипт нужен, чтобы добавить
// поле в уже собранный пилот без полного ре-фетча. Инкрементально по qid.
//
// Запуск: node scripts/enrich-website.mjs [--region name]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA = 'my_map-poi/0.0 (https://github.com/misht-world/my_map-poi; misht.world@gmail.com) node-fetch';

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSparql(query, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ query }),
      });
    } catch (e) { if (attempt >= retries) throw e; await sleep(2000 * (attempt + 1)); continue; }
    if (res.ok) return res.json();
    if ((res.status !== 429 && res.status < 500) || attempt >= retries) throw new Error(`SPARQL ${res.status}`);
    await sleep(Number(res.headers.get('retry-after')) * 1000 || 2000 * (attempt + 1));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const regions = JSON.parse(readFileSync(resolve(ROOT, 'config/regions.json'), 'utf8'));
  const ri = argv.indexOf('--region');
  const name = ri !== -1 && argv[ri + 1] && !argv[ri + 1].startsWith('--') ? argv[ri + 1] : regions.default;

  const src = resolve(ROOT, `data/enrich/${name}.enriched.json`);
  const qids = JSON.parse(readFileSync(src, 'utf8')).map((i) => i.qid);
  const outFile = resolve(ROOT, `data/enrich/${name}.website.json`);
  const result = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : {};

  const missing = qids.filter((q) => !(q in result));
  if (!missing.length) { console.log(`Сайты из кэша: ${Object.keys(result).length}`); return; }
  console.log(`Тяну P856 для ${missing.length} объектов…`);

  const batches = chunk(missing, 200);
  for (const [bi, batch] of batches.entries()) {
    const values = batch.map((q) => `wd:${q}`).join(' ');
    const q = `SELECT ?item ?site WHERE { VALUES ?item { ${values} } OPTIONAL { ?item wdt:P856 ?site } }`;
    const j = await runSparql(q);
    // отметим ВСЕ qid батча (даже без сайта — null), чтобы не перезапрашивать
    for (const qid of batch) result[qid] = result[qid] ?? null;
    for (const b of j.results.bindings) {
      if (b.site) result[b.item.value.split('/').pop()] = b.site.value;
    }
    process.stdout.write(`\r  батч ${bi + 1}/${batches.length}`);
    await sleep(250);
  }
  process.stdout.write('\n');

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(result));
  const withSite = Object.values(result).filter(Boolean).length;
  console.log(`С сайтом: ${withSite}/${Object.keys(result).length}`);
  console.log(`Сохранено: data/enrich/${name}.website.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
}
