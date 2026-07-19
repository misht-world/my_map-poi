// ЕВРОПА (SPEC §9), шаг подготовки: подклассовое замыкание корней категорий.
//
// В дампе Wikidata у объекта есть P31 (конкретные классы), но НЕ транзитивное замыкание
// подклассов. Чтобы фильтровать «instance-of/subclass* корня категории» при сканировании
// дампа за O(1), заранее считаем через SPARQL множество ВСЕХ подклассов каждого корня и
// строим карту class_qid → category. Приоритет при пересечении — порядок категорий в конфиге.
//
// Выход: data/eu/class-to-category.json  (+ blacklist-замыкание отдельным файлом).
// Запуск: node scripts/eu-build-closure.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA = 'my_map-poi/0.0 (https://github.com/misht-world/my_map-poi; misht.world@gmail.com) node-fetch';
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

/** Все подклассы (включая сам корень) набора корней: ?c wdt:P279* ?root. */
async function subclassesOf(roots) {
  const values = roots.map((q) => `wd:${q}`).join(' ');
  const q = `SELECT DISTINCT ?c WHERE { VALUES ?root { ${values} } ?c wdt:P279* ?root }`;
  const j = await runSparql(q);
  return j.results.bindings.map((b) => b.c.value.split('/').pop());
}

// «Битые мосты» — классы, ошибочно объявленные подклассом наших корней в Wikidata,
// тянущие за собой чужой огромный подграф. Их поддеревья вычитаем из замыкания.
// Q41207 «coin» ошибочно = подкласс скульптуры (Q860861) → тянет 144k типов монет
// в категорию «памятники». (Монеты без координат и так отсеются по P625, но не будем
// засорять.) При добавлении категорий проверять счётчики — аномально большой = новый мост.
const BAD_BRIDGES = ['Q41207'];

async function main() {
  const poiTypes = JSON.parse(readFileSync(resolve(ROOT, 'config/poi-types.json'), 'utf8'));
  const catOrder = Object.keys(poiTypes.categories);

  // Поддеревья битых мостов — вычесть из whitelist-замыкания.
  const excluded = new Set(await subclassesOf(BAD_BRIDGES));
  console.log(`Исключаю ${excluded.size} классов из битых мостов (${BAD_BRIDGES.join(',')})`);

  // class → category (приоритет = порядок категорий: первая назначившая побеждает)
  const classToCat = {};
  const perCat = {};
  for (const cat of catOrder) {
    const roots = Object.keys(poiTypes.categories[cat].roots);
    const classes = (await subclassesOf(roots)).filter((c) => !excluded.has(c));
    perCat[cat] = classes.length;
    for (const c of classes) if (!(c in classToCat)) classToCat[c] = cat;
    console.log(`  ${cat}: ${classes.length} классов (подклассы ${roots.length} корней)`);
    await sleep(400);
  }

  const blacklist = await subclassesOf(Object.keys(poiTypes.blacklist));
  console.log(`  blacklist: ${blacklist.length} классов`);

  mkdirSync(resolve(ROOT, 'data/eu'), { recursive: true });
  writeFileSync(resolve(ROOT, 'data/eu/class-to-category.json'), JSON.stringify(classToCat));
  writeFileSync(resolve(ROOT, 'data/eu/blacklist-classes.json'), JSON.stringify(blacklist));
  console.log(`\nВсего классов в whitelist-замыкании: ${Object.keys(classToCat).length}`);
  console.log('Сохранено: data/eu/class-to-category.json, data/eu/blacklist-classes.json');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
}
