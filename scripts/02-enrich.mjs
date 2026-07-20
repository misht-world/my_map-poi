// 02 — Enrich объектов из шага 2 (CLAUDE.md шаг 3).
//
// По qid добавляет поля для попапа (SPEC §2, §5): pageviews_90d, summary + wiki_url,
// Commons image_url + атрибуция (автор/лицензия/ссылка). Обогащение — на этапе сборки,
// НЕ в рантайме браузера. Клиент потом сетевых вызовов не делает.
//
// Каждая под-часть кэшируется на диск отдельным артефактом (data/enrich/<region>.*.json)
// и резюмируется: повторный прогон дотягивает только отсутствующие qid. На регион это не
// опция, а необходимость (CLAUDE.md) — 5.5k объектов × несколько API.
//
// Батчинг, где можно (§9): wbgetentities и Commons imageinfo — по 50; summary — Action API
// extracts по 20 на вики. pageviews остаётся per-article (bulk-эндпоинта нет), поэтому идёт
// с ограниченной параллельностью и кэшем.
//
// Запуск:
//   node scripts/02-enrich.mjs                 # регион по умолчанию, срез sl>=enrichMinSitelinks
//   node scripts/02-enrich.mjs --limit 25      # только первые 25 объектов (проверка)
//   node scripts/02-enrich.mjs --force         # игнорировать кэш, всё заново

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UA =
  'my_map-poi/0.0 (https://github.com/misht-world/my_map-poi; misht.world@gmail.com) node-fetch';

// Порядок предпочтения языка вики (для summary/pageviews). it/de/en — регион Южного
// Тироля, дальше — языки, для которых есть офлайн-модель перевода → русский (install_mt_models.py),
// чтобы текст можно было перевести. Бот-вики (ceb/war — миллионы автозаглушек) отодвинуты
// в самый конец: берём их только если реальной статьи нет вообще.
const LANG_PREFERENCE = ['it', 'de', 'en', 'fr', 'es', 'pt', 'nl', 'pl', 'cs', 'ro',
  'sv', 'uk', 'ja', 'ca', 'fi', 'da', 'hu', 'el', 'tr', 'sl', 'sk'];
const BOT_WIKIS = new Set(['cebwiki', 'warwiki']);

// Ключи sitelinks одиночных не-википедийных проектов (в отличие от xxwiki-википедий).
const NON_WIKIPEDIA_KEYS = new Set([
  'commonswiki', 'specieswiki', 'metawiki', 'wikidatawiki', 'mediawikiwiki',
  'incubatorwiki', 'sourceswiki', 'foundationwiki', 'outreachwiki', 'wikimaniawiki',
]);

// --- чистые хелперы (тестируются без сети) -----------------------------------

/** Имя файла Commons из URL wdt:P18 (Special:FilePath/<file>). */
export function extractFilename(filepathUrl) {
  const m = /Special:FilePath\/(.+)$/.exec(filepathUrl ?? '');
  return m ? decodeURIComponent(m[1]) : null;
}

/** Убирает HTML-теги и схлопывает пробелы (поле Artist из extmetadata — с разметкой). */
export function stripHtml(html) {
  return (html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Выбор вики-статьи для объекта из карты sitelinks (wiki-код → title).
 * Приоритет: LANG_PREFERENCE (переводимые языки) > любая не-бот википедия > бот-вики
 * (крайний случай). Возвращает { lang, title } или null.
 */
export function chooseSitelink(sitelinks) {
  for (const lang of LANG_PREFERENCE) {
    const key = `${lang}wiki`;
    if (sitelinks[key]) return { lang, title: sitelinks[key].title };
  }
  // любая другая (не-бот) википедия: ключ вида "xxwiki". Сестринские проекты с языком
  // (frwikisource…) не кончаются на "wiki" и отсекаются; одиночные не-википедийные —
  // явным набором; бот-вики (ceb/war) откладываем на последний проход.
  const isWiki = (key) => key.endsWith('wiki') && !NON_WIKIPEDIA_KEYS.has(key);
  for (const key of Object.keys(sitelinks)) {
    if (isWiki(key) && !BOT_WIKIS.has(key)) {
      return { lang: key.replace(/wiki$/, ''), title: sitelinks[key].title };
    }
  }
  // последний резерв — бот-вики (лучше, чем ничего, но текст скорее всего не переведём)
  for (const key of Object.keys(sitelinks)) {
    if (isWiki(key)) return { lang: key.replace(/wiki$/, ''), title: sitelinks[key].title };
  }
  return null;
}

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { retries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA } });
    } catch (e) {
      // Сетевой сбой (fetch бросил, а не вернул !ok) — тоже ретраим, не роняем прогон.
      if (attempt >= retries) throw e;
      await sleep(Math.min(1000 * 2 ** attempt, 30000));
      continue;
    }
    if (res.ok) return res.json();
    const retriable = res.status === 429 || res.status >= 500;
    if (!retriable || attempt >= retries) {
      throw new Error(`${res.status} ${res.statusText} @ ${url.slice(0, 120)}`);
    }
    // Учитываем Retry-After, иначе экспоненциальный бэкофф (429 от Commons на extmetadata).
    const waitMs = Number(res.headers.get('retry-after')) * 1000 || Math.min(1000 * 2 ** attempt, 30000);
    await sleep(waitMs);
  }
}

/** Ограниченно-параллельный map (для per-article pageviews). */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// --- сетевые под-шаги ---------------------------------------------------------

/** qid[] → Map qid → { lang, title } (батч wbgetentities по 50, props=sitelinks). */
async function resolveSitelinks(qids) {
  const result = new Map();
  const batches = chunk(qids, 50);
  for (const [bi, batch] of batches.entries()) {
    const url =
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${batch.join('|')}` +
      `&props=sitelinks&format=json&origin=*`;
    const j = await getJson(url);
    for (const qid of batch) {
      const sl = j.entities?.[qid]?.sitelinks;
      const chosen = sl ? chooseSitelink(sl) : null;
      if (chosen) result.set(qid, chosen);
    }
    process.stdout.write(`\r  sitelinks: батч ${bi + 1}/${batches.length}`);
    await sleep(200);
  }
  process.stdout.write('\n');
  return result;
}

/** Map qid→{lang,title} → Map qid → { summary, wiki_url } (Action API extracts по 20/вики). */
async function fetchSummaries(chosen) {
  const result = new Map();
  // группируем по языку вики
  const byLang = new Map();
  for (const [qid, { lang, title }] of chosen) {
    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang).push({ qid, title });
  }
  for (const [lang, entries] of byLang) {
    const batches = chunk(entries, 20);
    for (const [bi, batch] of batches.entries()) {
      const titles = batch.map((e) => e.title).join('|');
      const url =
        `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts|info` +
        `&inprop=url&exintro=1&explaintext=1&exlimit=20&redirects=1` +
        `&titles=${encodeURIComponent(titles)}&format=json&origin=*`;
      const j = await getJson(url);
      const pages = Object.values(j.query?.pages ?? {});
      // сопоставляем по нормализованному заголовку (API мог применить redirects/normalize)
      const byTitle = new Map();
      for (const p of pages) byTitle.set(normTitle(p.title), p);
      // учтём normalized/redirects маппинги
      const alias = new Map();
      for (const n of j.query?.normalized ?? []) alias.set(normTitle(n.from), normTitle(n.to));
      for (const rd of j.query?.redirects ?? []) alias.set(normTitle(rd.from), normTitle(rd.to));
      for (const e of batch) {
        let key = normTitle(e.title);
        key = alias.get(key) ?? key;
        const p = byTitle.get(key);
        if (p?.extract) {
          result.set(e.qid, {
            summary: p.extract,
            wiki_url: p.fullurl ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(e.title)}`,
          });
        }
      }
      process.stdout.write(`\r  summary(${lang}): батч ${bi + 1}/${batches.length}   `);
      await sleep(200);
    }
  }
  process.stdout.write('\n');
  return result;
}

const normTitle = (t) => (t ?? '').replace(/_/g, ' ').trim();

/** Map qid→{lang,title} → Map qid → pageviews_90d (per-article, ограниченная параллельность). */
async function fetchPageviews(chosen) {
  const end = new Date();
  const start = new Date(Date.now() - 90 * 864e5);
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const entries = [...chosen.entries()];
  let done = 0;
  const result = new Map();
  // Параллельность 3 + пауза: REST-эндпоинт pageviews строг по rate-limit, при бурсте
  // отдаёт 429 (getJson теперь ретраит с бэкоффом, но лучше не провоцировать).
  await mapLimit(entries, 3, async ([qid, { lang, title }]) => {
    const url =
      `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${lang}.wikipedia` +
      `/all-access/all-agents/${encodeURIComponent(title)}/daily/${fmt(start)}/${fmt(end)}`;
    try {
      const j = await getJson(url);
      const total = (j.items ?? []).reduce((a, x) => a + x.views, 0);
      result.set(qid, total);
    } catch {
      result.set(qid, 0); // 404 — нет данных (новая статья/редкий язык), не роняем прогон
    }
    await sleep(60);
    if (++done % 100 === 0) process.stdout.write(`\r  pageviews: ${done}/${entries.length}`);
  });
  process.stdout.write(`\r  pageviews: ${entries.length}/${entries.length}\n`);
  return result;
}

/**
 * Объекты с P18 → Map qid → { image_url, image_page, image_attribution } (imageinfo по 50).
 * Без автора ИЛИ лицензии фото НЕ публикуется (CLAUDE.md, SPEC §6) — qid просто не попадёт в map.
 */
async function fetchPhotos(items) {
  const withImg = items.filter((i) => i.image).map((i) => ({ qid: i.qid, file: extractFilename(i.image) })).filter((x) => x.file);
  const result = new Map();
  const batches = chunk(withImg, 50);
  for (const [bi, batch] of batches.entries()) {
    const titles = batch.map((e) => `File:${e.file}`).join('|');
    const url =
      `https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo` +
      `&iiprop=url|extmetadata&iiextmetadatafilter=Artist|LicenseShortName|LicenseUrl` +
      `&titles=${encodeURIComponent(titles)}&format=json&origin=*`;
    const j = await getJson(url);
    const byFile = new Map();
    for (const p of Object.values(j.query?.pages ?? {})) {
      if (p.imageinfo?.[0]) byFile.set(normTitle(p.title).replace(/^File:/i, ''), p.imageinfo[0]);
    }
    for (const e of batch) {
      const info = byFile.get(normTitle(`File:${e.file}`).replace(/^File:/i, ''));
      if (!info) continue;
      const m = info.extmetadata ?? {};
      const author = stripHtml(m.Artist?.value);
      const license = m.LicenseShortName?.value;
      if (!author || !license) continue; // нет атрибуции — фото не берём
      result.set(e.qid, {
        image_url: info.url,
        image_page: info.descriptionurl,
        image_attribution: {
          author,
          license,
          license_url: m.LicenseUrl?.value ?? null,
          source: info.descriptionurl,
        },
      });
    }
    process.stdout.write(`\r  photos: батч ${bi + 1}/${batches.length}   `);
    await sleep(700); // Commons imageinfo+extmetadata строже по лимиту — пауза больше

  }
  process.stdout.write('\n');
  return result;
}

// --- кэш-обёртка (инкрементальная, по qid) ------------------------------------

// Кэш резюмируется по qid: обрабатываются только отсутствующие в нём объекты.
// Это позволяет расширять whitelist (новые категории) без пересчёта уже готовых.
function loadCache(file, force) {
  if (force || !existsSync(file)) return new Map();
  return new Map(JSON.parse(readFileSync(file, 'utf8')).entries);
}
function saveCache(file, map) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ n: map.size, entries: [...map] }));
}
const mergeInto = (target, add) => { for (const [k, v] of add) target.set(k, v); return target; };

// --- CLI ----------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const regions = JSON.parse(readFileSync(resolve(ROOT, 'config/regions.json'), 'utf8'));
  const scoring = JSON.parse(readFileSync(resolve(ROOT, 'config/scoring.json'), 'utf8'));
  const force = argv.includes('--force');
  const limitArg = argv.indexOf('--limit');
  const limit = limitArg !== -1 ? Number(argv[limitArg + 1]) : Infinity;
  const ri = argv.indexOf('--region');
  const name = ri !== -1 && argv[ri + 1] && !argv[ri + 1].startsWith('--') ? argv[ri + 1] : regions.default;

  const fetchFile = resolve(ROOT, `data/fetch/${name}.json`);
  if (!existsSync(fetchFile)) throw new Error(`Нет ${fetchFile} — сначала шаг 2 (01-fetch --region)`);
  const all = JSON.parse(readFileSync(fetchFile, 'utf8'));
  const minSl = scoring.enrichMinSitelinks ?? 2;
  let items = all.filter((i) => i.sitelinks_count >= minSl);
  if (Number.isFinite(limit)) items = items.slice(0, limit);
  const qids = items.map((i) => i.qid);
  console.log(`Регион "${name}": обогащаю ${items.length} объектов (sl>=${minSl}${Number.isFinite(limit) ? `, limit ${limit}` : ''})`);

  const cacheBase = resolve(ROOT, `data/enrich/${name}`);
  const qidSet = new Set(qids);

  // 1) sitelinks → выбор вики (только для отсутствующих в кэше)
  const chosen = loadCache(`${cacheBase}.sitelinks.json`, force);
  const missSl = qids.filter((q) => !chosen.has(q));
  if (missSl.length) {
    console.log(`→ resolve sitelinks (${missSl.length} новых, ${chosen.size} из кэша)…`);
    mergeInto(chosen, await resolveSitelinks(missSl));
    saveCache(`${cacheBase}.sitelinks.json`, chosen);
  } else console.log(`→ sitelinks из кэша (${chosen.size})`);

  // 2) summary (для выбранных вики, отсутствующих в кэше)
  const summaries = loadCache(`${cacheBase}.summary.json`, force);
  const missSum = new Map([...chosen].filter(([q]) => qidSet.has(q) && !summaries.has(q)));
  if (missSum.size) {
    console.log(`→ summary (${missSum.size} новых)…`);
    mergeInto(summaries, await fetchSummaries(missSum));
    saveCache(`${cacheBase}.summary.json`, summaries);
  } else console.log(`→ summary из кэша (${summaries.size})`);

  // 3) pageviews
  const pageviews = loadCache(`${cacheBase}.pageviews.json`, force);
  const missPv = new Map([...chosen].filter(([q]) => qidSet.has(q) && !pageviews.has(q)));
  if (missPv.size) {
    console.log(`→ pageviews (${missPv.size} новых)…`);
    mergeInto(pageviews, await fetchPageviews(missPv));
    saveCache(`${cacheBase}.pageviews.json`, pageviews);
  } else console.log(`→ pageviews из кэша (${pageviews.size})`);

  // 4) photos + attribution (объекты с image, отсутствующие в кэше)
  const photos = loadCache(`${cacheBase}.photos.json`, force);
  const missPhoto = items.filter((i) => i.image && !photos.has(i.qid));
  if (missPhoto.length) {
    console.log(`→ photos + attribution (${missPhoto.length} новых)…`);
    mergeInto(photos, await fetchPhotos(missPhoto));
    saveCache(`${cacheBase}.photos.json`, photos);
  } else console.log(`→ photos из кэша (${photos.size})`);

  // merge
  const enriched = items.map((i) => {
    const s = summaries.get(i.qid);
    const ph = photos.get(i.qid);
    return {
      ...i,
      pageviews_90d: pageviews.get(i.qid) ?? 0,
      has_image: Boolean(ph),
      summary: s?.summary ?? null,
      wiki_url: s?.wiki_url ?? null,
      image_url: ph?.image_url ?? null,
      image_page: ph?.image_page ?? null,
      image_attribution: ph?.image_attribution ?? null,
    };
  });

  mkdirSync(resolve(ROOT, 'data/enrich'), { recursive: true });
  const out = resolve(ROOT, `data/enrich/${name}.enriched.json`);
  writeFileSync(out, JSON.stringify(enriched, null, 2));

  const nSum = enriched.filter((e) => e.summary).length;
  const nPhoto = enriched.filter((e) => e.image_url).length;
  const nPv = enriched.filter((e) => e.pageviews_90d > 0).length;
  console.log('\nИтог enrich:');
  console.log(`  summary:     ${nSum}/${enriched.length}`);
  console.log(`  фото+атриб.: ${nPhoto}/${enriched.length}`);
  console.log(`  pageviews>0: ${nPv}/${enriched.length}`);
  console.log(`Сохранено: data/enrich/${name}.enriched.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('\n' + e.message);
    process.exit(1);
  });
}
