// Дотягивает URL статьи в ru.wikipedia (если есть) для пилота — чтобы ссылка «Wikipedia»
// в попапе вела на русскую статью, когда она существует. Для Европы ru-sitelink берётся
// из дампа. Инкрементально по qid. SPARQL-батч (schema:about).
//
// Запуск: node scripts/enrich-ruwiki.mjs [--region name]

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
  const outFile = resolve(ROOT, `data/enrich/${name}.ruwiki.json`);
  const result = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : {};

  const missing = qids.filter((q) => !(q in result));
  if (!missing.length) { console.log(`ru-ссылки из кэша: ${Object.keys(result).length}`); return; }
  console.log(`Тяну ru.wikipedia-ссылки для ${missing.length} объектов…`);

  const batches = chunk(missing, 200);
  for (const [bi, batch] of batches.entries()) {
    const values = batch.map((q) => `wd:${q}`).join(' ');
    const q = `SELECT ?item ?article WHERE { VALUES ?item { ${values} } ` +
      `?article schema:about ?item ; schema:isPartOf <https://ru.wikipedia.org/> . }`;
    const j = await runSparql(q);
    for (const qid of batch) result[qid] = result[qid] ?? null; // отметить, чтобы не перезапрашивать
    for (const b of j.results.bindings) result[b.item.value.split('/').pop()] = b.article.value;
    process.stdout.write(`\r  батч ${bi + 1}/${batches.length}`);
    await sleep(250);
  }
  process.stdout.write('\n');

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(result));
  const withRu = Object.values(result).filter(Boolean).length;
  console.log(`С ru-статьёй: ${withRu}/${Object.keys(result).length}`);
  console.log(`Сохранено: data/enrich/${name}.ruwiki.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
}
