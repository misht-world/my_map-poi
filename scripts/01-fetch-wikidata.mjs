// 01 — Fetch объектов Wikidata по одному под-bbox'у (CLAUDE.md шаг 2).
//
// Интерфейс намеренно: bbox → массив { qid, lat, lon, sitelinks_count, image,
// commons_category, label, description }. SPEC §9: позже реализацию можно подменить
// на dump-based без изменений в enrich/score/normalize — сигнатуру не трогать.
//
// Сейчас реализовано ровно ОДНОЙ клеткой (не сетка на весь регион). Сетка + паузы +
// дедуп на границах — следующий подшаг, когда на реальном ответе увидим, что поля
// приходят (Wikidata SPARQL капризен к синтаксису).
//
// Запуск:
//   node scripts/01-fetch-wikidata.mjs                 # тестовая клетка Тренто из regions.json
//   node scripts/01-fetch-wikidata.mjs W S E N         # произвольный bbox

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = 'https://query.wikidata.org/sparql';
// Wikimedia требует осмысленный User-Agent, иначе блокирует запрос.
const USER_AGENT =
  'my_map-poi/0.0 (https://github.com/misht-world/my_map-poi; misht.world@gmail.com) node-fetch';

const QUERY_TEMPLATE = readFileSync(
  resolve(ROOT, 'scripts/queries/poi-in-bbox.rq'),
  'utf8',
);

// P31-фильтр (SPEC §1a): Q-id whitelist/blacklist живут в конфиге, не в запросе.
const poiTypes = JSON.parse(
  readFileSync(resolve(ROOT, 'config/poi-types.json'), 'utf8'),
);
const toValues = (obj) =>
  Object.keys(obj)
    .filter((k) => !k.startsWith('$'))
    .map((qid) => `wd:${qid}`)
    .join(' ');
// whitelist = объединение корней всех категорий (config/poi-types.json → categories).
const allRoots = {};
for (const cat of Object.values(poiTypes.categories)) Object.assign(allRoots, cat.roots);
export const WHITELIST_VALUES = toValues(allRoots);
export const BLACKLIST_VALUES = toValues(poiTypes.blacklist);

/**
 * Подставляет bbox и VALUES-списки типов в шаблон запроса. Одна замена плейсхолдеров,
 * без склейки из кусков. Q-id берутся из config/poi-types.json (единственное место).
 * @param {{west:number,south:number,east:number,north:number}} bbox
 */
export function buildQuery({ west, south, east, north }) {
  // replaceAll, а не replace: плейсхолдеры встречаются и в тексте комментария .rq —
  // replace заменил бы только первое (комментарийное) вхождение, оставив Point(...) битым.
  return QUERY_TEMPLATE.replaceAll('{{WEST}}', west)
    .replaceAll('{{SOUTH}}', south)
    .replaceAll('{{EAST}}', east)
    .replaceAll('{{NORTH}}', north)
    .replaceAll('{{WHITELIST}}', WHITELIST_VALUES)
    .replaceAll('{{BLACKLIST}}', BLACKLIST_VALUES);
}

/** "Point(11.12 46.07)" → { lon: 11.12, lat: 46.07 }; иначе null. */
export function parsePoint(wkt) {
  const m = /^Point\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/i.exec(wkt ?? '');
  if (!m) return null;
  return { lon: Number(m[1]), lat: Number(m[2]) };
}

/** URI объекта Wikidata → QID (http://www.wikidata.org/entity/Q42 → Q42). */
function qidFromUri(uri) {
  const i = uri.lastIndexOf('/');
  return i === -1 ? uri : uri.slice(i + 1);
}

/**
 * Сырые SPARQL-биндинги → дедуплицированный по qid массив объектов.
 * Несколько строк на объект (несколько P18/P373) сливаются: первое непустое значение.
 * @param {{results:{bindings:object[]}}} sparqlJson
 */
export function normalizeBindings(sparqlJson) {
  const byQid = new Map();
  for (const b of sparqlJson.results.bindings) {
    const qid = qidFromUri(b.item.value);
    const point = parsePoint(b.coord?.value);
    if (!point) continue; // без координат объекту на карте делать нечего

    const existing = byQid.get(qid);
    if (existing) {
      existing.image ??= b.image?.value ?? null;
      existing.commons_category ??= b.commons?.value ?? null;
      continue;
    }
    byQid.set(qid, {
      qid,
      lat: point.lat,
      lon: point.lon,
      sitelinks_count: Number(b.sitelinks.value),
      image: b.image?.value ?? null,
      commons_category: b.commons?.value ?? null,
      // Label от wikibase:label при отсутствии падает в QID — тогда считаем пустым.
      label: b.itemLabel && b.itemLabel.value !== qid ? b.itemLabel.value : null,
      description: b.itemDescription?.value ?? null,
    });
  }
  return [...byQid.values()];
}

/** POST запроса на endpoint с ретраями на 429/5xx. Возвращает распарсенный JSON. */
async function runSparql(query, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/sparql-results+json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ query }),
    });
    if (res.ok) return res.json();

    const retriable = res.status === 429 || res.status >= 500;
    if (!retriable || attempt >= retries) {
      const body = await res.text().catch(() => '');
      throw new Error(`SPARQL ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    }
    const waitMs = Number(res.headers.get('retry-after')) * 1000 || 2000 * (attempt + 1);
    console.warn(`  ↳ ${res.status}, повтор через ${waitMs}ms (попытка ${attempt + 1})`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/**
 * Публичный интерфейс шага 2: bbox → нормализованный массив объектов.
 * @param {{west:number,south:number,east:number,north:number}} bbox
 */
export async function fetchCell(bbox) {
  const raw = await runSparql(buildQuery(bbox));
  return { raw, items: normalizeBindings(raw) };
}

/**
 * Нарезка bbox региона на сетку под-bbox'ов по cellSize (SPEC §2). Крайние клетки
 * подрезаются по границе региона, чтобы не выходить за bbox.
 * @param {{west:number,south:number,east:number,north:number}} bbox
 * @param {number} cellSize градусы
 */
export function gridCells(bbox, cellSize) {
  const cols = Math.ceil((bbox.east - bbox.west) / cellSize);
  const rows = Math.ceil((bbox.north - bbox.south) / cellSize);
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const west = bbox.west + c * cellSize;
      const south = bbox.south + r * cellSize;
      cells.push({
        col: c,
        row: r,
        west,
        south,
        east: Math.min(west + cellSize, bbox.east),
        north: Math.min(south + cellSize, bbox.north),
      });
    }
  }
  return cells;
}

const isTimeoutError = (e) => /timeout|java\.util\.concurrent|estimated execution time/i.test(e?.message ?? '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch одной клетки с адаптивным дроблением: если Wikidata отдаёт таймаут на
 * плотной клетке (город), делим её 2×2 и добираем по под-клеткам (SPEC §2, §8).
 * @returns {Promise<object[]>} объекты (ещё не дедуплицированные между клетками)
 */
export async function fetchCellAdaptive(bbox, { depth = 0, maxDepth = 3, pauseMs = 1000 } = {}) {
  try {
    const { items } = await fetchCell(bbox);
    return items;
  } catch (e) {
    if (!isTimeoutError(e) || depth >= maxDepth) throw e;
    const midLon = (bbox.west + bbox.east) / 2;
    const midLat = (bbox.south + bbox.north) / 2;
    const quads = [
      { west: bbox.west, south: bbox.south, east: midLon, north: midLat },
      { west: midLon, south: bbox.south, east: bbox.east, north: midLat },
      { west: bbox.west, south: midLat, east: midLon, north: bbox.north },
      { west: midLon, south: midLat, east: bbox.east, north: bbox.north },
    ];
    console.warn(`    таймаут на клетке — делю 2×2 (глубина ${depth + 1})`);
    const out = [];
    for (const q of quads) {
      out.push(...(await fetchCellAdaptive(q, { depth: depth + 1, maxDepth, pauseMs })));
      await sleep(pauseMs);
    }
    return out;
  }
}

/**
 * Прогон всего региона по сетке клеток: пауза между запросами, дедуп по qid на
 * границах клеток, дисковый кэш каждой клетки (повторный прогон переиспользует).
 * @param {{bbox:object, cellSize:number}} region
 * @param {{cacheDir?:string, pauseMs?:number, force?:boolean}} opts
 */
export async function fetchRegion(region, { cacheDir, pauseMs = 1000, force = false } = {}) {
  const cells = gridCells(region.bbox, region.cellSize);
  const byQid = new Map();
  let cached = 0;
  let fetched = 0;

  for (const [idx, cell] of cells.entries()) {
    const cacheFile = cacheDir ? resolve(cacheDir, `cell_${cell.col}_${cell.row}.json`) : null;
    let items;

    if (cacheFile && !force && existsSync(cacheFile)) {
      items = JSON.parse(readFileSync(cacheFile, 'utf8'));
      cached++;
    } else {
      process.stdout.write(
        `  [${idx + 1}/${cells.length}] клетка ${cell.col},${cell.row} ` +
          `[${cell.west.toFixed(2)},${cell.south.toFixed(2)}..${cell.east.toFixed(2)},${cell.north.toFixed(2)}] `,
      );
      const t0 = Date.now();
      items = await fetchCellAdaptive(cell, { pauseMs });
      console.log(`→ ${items.length} за ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      if (cacheFile) {
        mkdirSync(dirname(cacheFile), { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(items));
      }
      fetched++;
      await sleep(pauseMs);
    }

    for (const it of items) if (!byQid.has(it.qid)) byQid.set(it.qid, it);
  }

  const items = [...byQid.values()];
  console.log(
    `Регион: клеток ${cells.length} (из кэша ${cached}, запрошено ${fetched}), ` +
      `уникальных объектов ${items.length}`,
  );
  return items;
}

// --- CLI ---------------------------------------------------------------------

async function main() {
  const regions = JSON.parse(
    readFileSync(resolve(ROOT, 'config/regions.json'), 'utf8'),
  );
  const argv = process.argv.slice(2);

  // Режим сетки на весь регион: node 01-fetch-wikidata.mjs --region [name] [--force]
  if (argv.includes('--region')) {
    const i = argv.indexOf('--region');
    const name = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : regions.default;
    const region = regions.regions[name];
    if (!region) throw new Error(`Регион "${name}" не найден в config/regions.json`);

    console.log(`Регион "${name}": bbox`, region.bbox, `cellSize ${region.cellSize}°`);
    const cacheDir = resolve(ROOT, `data/raw/cells/${name}`);
    const items = await fetchRegion(region, { cacheDir, force: argv.includes('--force') });

    mkdirSync(resolve(ROOT, 'data/fetch'), { recursive: true });
    const out = resolve(ROOT, `data/fetch/${name}.json`);
    writeFileSync(out, JSON.stringify(items, null, 2));
    reportFields(items);
    console.log(`\nСохранено: data/fetch/${name}.json (кэш клеток: data/raw/cells/${name}/)`);
    return;
  }

  // Режим одной клетки (по умолчанию — тестовая клетка Тренто).
  const args = argv.map(Number);
  let bbox;
  let cellName;
  if (args.length === 4 && args.every(Number.isFinite)) {
    bbox = { west: args[0], south: args[1], east: args[2], north: args[3] };
    cellName = `custom_${args.join('_')}`;
  } else {
    bbox = regions.testCell.bbox;
    cellName = regions.testCell.name ?? 'testcell';
  }

  console.log(`Клетка "${cellName}": bbox`, bbox);
  const t0 = Date.now();
  const { raw, items } = await fetchCell(bbox);
  console.log(`Ответ за ${((Date.now() - t0) / 1000).toFixed(1)}s, объектов: ${items.length}`);

  // Кэш сырого ответа (отладка в WQS) + нормализованный список — оба на диск.
  mkdirSync(resolve(ROOT, 'data/raw'), { recursive: true });
  mkdirSync(resolve(ROOT, 'data/fetch'), { recursive: true });
  writeFileSync(resolve(ROOT, `data/raw/${cellName}.sparql.json`), JSON.stringify(raw, null, 2));
  writeFileSync(resolve(ROOT, `data/fetch/${cellName}.json`), JSON.stringify(items, null, 2));

  reportFields(items);
  console.log(`\nСохранено: data/raw/${cellName}.sparql.json, data/fetch/${cellName}.json`);
}

/** Проверка, что нужные поля реально приходят + топ по sitelinks (диагностика). */
function reportFields(items) {
  const withImage = items.filter((i) => i.image).length;
  const withCommons = items.filter((i) => i.commons_category).length;
  const withLabel = items.filter((i) => i.label).length;
  console.log('Присутствие полей:');
  console.log(`  P18 image:        ${withImage}/${items.length}`);
  console.log(`  P373 commons cat: ${withCommons}/${items.length}`);
  console.log(`  label (it/de/en): ${withLabel}/${items.length}`);
  console.log('Топ-5 по sitelinks:');
  for (const i of [...items].sort((a, b) => b.sitelinks_count - a.sitelinks_count).slice(0, 5)) {
    console.log(
      `  ${i.qid.padEnd(10)} sl=${String(i.sitelinks_count).padStart(3)}  ` +
        `${i.image ? 'P18 ' : '    '}${i.commons_category ? 'P373 ' : '     '} ${i.label ?? '(no label)'}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
