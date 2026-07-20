// ЕВРОПА (SPEC §9), шаг 1: потоковый парсер дампа Wikidata.
//
// Заменяет живой SPARQL по сетке: читает latest-all.json.gz ПОТОКОМ (не распаковывая
// целиком) и на лету отбирает достопримечательности — координаты (P625) в bbox +
// хотя бы один НЕ-бот sitelink + P31 в подклассовом замыкании категорий (data/eu/), не в
// blacklist. Сразу извлекает всё, что есть в дампе: qid, координаты, категорию, label(+ru),
// description_ru, P18, P856, выбранную вики-статью и ru-статью. Остаётся дозагрузить сетью
// только pageviews/summary/commons-атрибуцию + перевод summary.
//
// Ускорение: строки без "P625" (у большинства сущностей нет координат) отсеиваются ДО
// JSON.parse — это на порядок меньше парсинга.
//
// Прерываемость: чекпоинт по числу просмотренных сущностей (gzip не seek-абелен, поэтому
// resume перематывает поток БЕЗ парсинга до чекпоинта — декомпрессия быстрее парсинга).
// Вывод дописывается построчно (JSONL); возможные дубли на границе чекпоинта убирает дедуп
// по qid ниже по пайплайну.
//
// Запуск:  node scripts/eu-01-parse-dump.mjs [--region europe] [--dump PATH]
//   первый прогон Италии для сверки:  --region italy

import { createReadStream, existsSync, readFileSync, writeFileSync, createWriteStream, statSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Бот-вики (миллионы автозаглушек) и одиночные не-википедийные проекты — не считаем как
// значимый sitelink и не выбираем как источник статьи (согласовано с 02-enrich.mjs).
const BOT_WIKIS = new Set(['cebwiki', 'warwiki']);
const NON_WIKIPEDIA_KEYS = new Set([
  'commonswiki', 'specieswiki', 'metawiki', 'wikidatawiki', 'mediawikiwiki',
  'incubatorwiki', 'sourceswiki', 'foundationwiki', 'outreachwiki', 'wikimaniawiki',
]);
const LANG_PREFERENCE = ['it', 'de', 'en', 'fr', 'es', 'pt', 'nl', 'pl', 'cs', 'ro',
  'sv', 'uk', 'ja', 'ca', 'fi', 'da', 'hu', 'el', 'tr', 'sl', 'sk'];

const isRealWiki = (key) => key.endsWith('wiki') && !NON_WIKIPEDIA_KEYS.has(key) && !BOT_WIKIS.has(key);

/** Выбор вики-статьи (для summary/pageviews): переводимые языки, затем любая не-бот. */
function chooseWiki(sitelinks) {
  for (const lang of LANG_PREFERENCE) {
    const k = `${lang}wiki`;
    if (sitelinks[k]) return { lang, title: sitelinks[k].title };
  }
  for (const k of Object.keys(sitelinks)) {
    if (isRealWiki(k)) return { lang: k.replace(/wiki$/, ''), title: sitelinks[k].title };
  }
  return null;
}

function firstLabel(labels) {
  for (const lang of ['it', 'de', 'en', ...LANG_PREFERENCE]) {
    if (labels[lang]) return labels[lang].value;
  }
  const any = Object.values(labels)[0];
  return any ? any.value : null;
}

/**
 * Фабрика извлекателя (замыкает конфиг: bbox, class→category, blacklist, приоритет).
 * entity (в формате дампа) → запись или null. Экспортируется для юнит-теста.
 */
export function makeExtractor({ bbox, classToCat, blacklist, catRank }) {
  const inBbox = (lat, lon) => lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
  return function extract(e) {
    if (e.type !== 'item' || !e.claims) return null;
    const p625 = e.claims.P625?.[0]?.mainsnak;
    if (!p625 || p625.snaktype !== 'value') return null;
    const coord = p625.datavalue?.value;
    if (!coord || (coord.globe && !coord.globe.endsWith('Q2'))) return null; // только Земля
    const lat = coord.latitude, lon = coord.longitude;
    if (!inBbox(lat, lon)) return null;

    const p31 = (e.claims.P31 || []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
    if (p31.some((c) => blacklist.has(c))) return null; // населённый пункт/админ — прочь
    let category = null, best = Infinity;
    for (const c of p31) {
      const cat = classToCat[c];
      if (cat && catRank[cat] < best) { category = cat; best = catRank[cat]; }
    }
    if (!category) return null; // тип не в whitelist

    const sitelinks = e.sitelinks || {};
    let slCount = 0;
    for (const k of Object.keys(sitelinks)) if (isRealWiki(k)) slCount++;
    if (slCount < 1) return null; // нет ни одной значимой (не-бот) статьи

    const labels = e.labels || {};
    const descriptions = e.descriptions || {};
    const wiki = chooseWiki(sitelinks);
    const p18 = e.claims.P18?.[0]?.mainsnak?.datavalue?.value || null;
    const p856 = e.claims.P856?.[0]?.mainsnak?.datavalue?.value || null;

    return {
      qid: e.id,
      lat, lon,
      sitelinks_count: slCount,
      category,
      label: firstLabel(labels),
      label_ru: labels.ru?.value || null,
      description_ru: descriptions.ru?.value || null,
      image: p18,
      website: typeof p856 === 'string' ? p856 : null,
      wiki_lang: wiki?.lang || null,
      wiki_title: wiki?.title || null,
      ru_title: sitelinks.ruwiki?.title || null,
    };
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const regions = JSON.parse(readFileSync(resolve(ROOT, 'config/regions.json'), 'utf8'));
  const poiTypes = JSON.parse(readFileSync(resolve(ROOT, 'config/poi-types.json'), 'utf8'));
  const ri = argv.indexOf('--region');
  const name = ri !== -1 && argv[ri + 1] && !argv[ri + 1].startsWith('--') ? argv[ri + 1] : 'europe';
  const di = argv.indexOf('--dump');
  const dump = di !== -1 ? argv[di + 1] : 'D:/wikidata-dump/latest-all.json.gz';

  const bbox = regions.regions[name].bbox;
  const classToCat = JSON.parse(readFileSync(resolve(ROOT, 'data/eu/class-to-category.json'), 'utf8'));
  const blacklist = new Set(JSON.parse(readFileSync(resolve(ROOT, 'data/eu/blacklist-classes.json'), 'utf8')));
  const catRank = Object.fromEntries(Object.keys(poiTypes.categories).map((c, i) => [c, i]));

  if (!existsSync(dump)) throw new Error(`Нет дампа: ${dump}`);
  const totalBytes = statSync(dump).size;

  const outFile = resolve(ROOT, `data/eu/${name}.parsed.jsonl`);
  const ckFile = resolve(ROOT, `data/eu/${name}.parse-checkpoint.json`);
  let skipTo = 0, matched = 0;
  if (existsSync(ckFile) && existsSync(outFile)) {
    const ck = JSON.parse(readFileSync(ckFile, 'utf8'));
    skipTo = ck.seen; matched = ck.matched;
    console.log(`Резюм: пропускаю ${skipTo.toLocaleString()} сущностей (уже найдено ${matched})`);
  }
  const out = createWriteStream(outFile, { flags: skipTo ? 'a' : 'w' });
  const extract = makeExtractor({ bbox, classToCat, blacklist, catRank });

  const t0 = Date.now();
  const fileStream = createReadStream(dump);
  const rl = createInterface({ input: fileStream.pipe(createGunzip()), crlfDelay: Infinity });

  let seen = 0;
  const save = () => writeFileSync(ckFile, JSON.stringify({ seen, matched }));
  const progress = () => {
    const gb = fileStream.bytesRead / 1073741824;
    const pct = (100 * fileStream.bytesRead / totalBytes).toFixed(1);
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(`  ${(seen / 1e6).toFixed(1)}M сущностей | ${gb.toFixed(1)}/${(totalBytes / 1073741824).toFixed(0)} ГБ (${pct}%) | найдено ${matched} | ${mins} мин`);
  };

  for await (const line of rl) {
    seen++;
    if (seen <= skipTo) { if (seen % 5e6 === 0) console.log(`  …перемотка ${(seen / 1e6).toFixed(0)}M`); continue; }
    if (line.length < 40 || !line.includes('"P625"')) { // быстрый отсев: нет координат
      if (seen % 2e6 === 0) { save(); progress(); }
      continue;
    }
    const s = line.endsWith(',') ? line.slice(0, -1) : line;
    let e;
    try { e = JSON.parse(s); } catch { continue; }
    const rec = extract(e);
    if (rec) { out.write(JSON.stringify(rec) + '\n'); matched++; }
    if (seen % 2e6 === 0) { save(); progress(); }
  }

  out.end();
  save();
  console.log(`\nГотово: просмотрено ${seen.toLocaleString()} сущностей, найдено ${matched} объектов`);
  console.log(`Сохранено: data/eu/${name}.parsed.jsonl`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
}
