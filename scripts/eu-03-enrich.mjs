// ЕВРОПА, шаг 3: enrich значимого среза (фаза 2).
//
// У распарсенных объектов уже есть имя/ру-имя/описание/категория/координаты/фото-файл/сайт/
// вики-статья/ru-статья (всё из дампа). Здесь сетью дотягиваем то, чего в дампе нет:
//   • pageviews_90d  (для размера маркеров по популярности)
//   • summary        (абзац: нативный из ru.wikipedia если есть ru_title, иначе из wiki_lang)
//   • фото           (Commons imageinfo: author/license + CORS-чистый thumb_url для фото-маркеров)
//
// Обрабатывается СРЕЗ по значимости (--min = порог sitelinks_count, дефолт 5), иначе 514k ×
// сетевые вызовы — недопустимо. Резюмируемо: кэш по частям (data/eu/europe.enr-*.json), при
// перезапуске дотягиваются только новые qid. МАШИННЫЙ ПЕРЕВОД summary здесь НЕ делается —
// нативный ru берётся сразу; для остальных summary остаётся на языке источника, перевод —
// отдельным проходом (translate_ru-подобным) позже.
//
// Запуск:
//   node scripts/eu-03-enrich.mjs --limit 50      # проба на 50 объектах
//   node scripts/eu-03-enrich.mjs --min 5         # весь срез sitelinks>=5 (долго, часы)
//
// Итог: data/eu/europe.enriched.jsonl (парс + добавленные поля). Дальше — re-normalize + tile.

import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'my_map-poi/0.0 (https://github.com/misht-world/my_map-poi; misht.world@gmail.com) node-fetch';

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { retries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await fetch(url, { headers: { 'User-Agent': UA } }); }
    catch (e) { if (attempt >= retries) throw e; await sleep(Math.min(1000 * 2 ** attempt, 30000)); continue; }
    if (res.ok) return res.json();
    if ((res.status !== 429 && res.status < 500) || attempt >= retries) throw new Error(`${res.status} @ ${url.slice(0, 90)}`);
    await sleep(Number(res.headers.get('retry-after')) * 1000 || Math.min(1000 * 2 ** attempt, 30000));
  }
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const work = async () => { while (i < items.length) { const idx = i++; await fn(items[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, work));
}

const loadCache = (f) => existsSync(f) ? new Map(JSON.parse(readFileSync(f, 'utf8'))) : new Map();
const saveCache = (f, m) => writeFileSync(f, JSON.stringify([...m]));

// --- под-шаги -----------------------------------------------------------------

async function fetchPageviews(items, cache, save) {
  const end = new Date(), start = new Date(Date.now() - 90 * 864e5);
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const todo = items.filter((r) => r.wiki_lang && r.wiki_title && !cache.has(r.qid));
  let done = 0;
  await mapLimit(todo, 3, async (r) => {
    const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${r.wiki_lang}.wikipedia/all-access/all-agents/${encodeURIComponent(r.wiki_title)}/daily/${fmt(start)}/${fmt(end)}`;
    try { const j = await getJson(url); cache.set(r.qid, (j.items ?? []).reduce((a, x) => a + x.views, 0)); }
    catch { cache.set(r.qid, 0); }
    await sleep(50);
    if (++done % 200 === 0) { process.stdout.write(`\r  pageviews ${done}/${todo.length}`); save(); }
  });
  process.stdout.write(`\r  pageviews ${todo.length}/${todo.length}\n`); save();
}

async function fetchSummaries(items, cache, save) {
  // Нативный ru.wikipedia для объектов с ru_title (Action API extracts, батч 20 на вики).
  const byLang = new Map(); // lang -> [{qid,title}]
  for (const r of items) {
    if (cache.has(r.qid)) continue;
    const lang = r.ru_title ? 'ru' : r.wiki_lang;
    const title = r.ru_title || r.wiki_title;
    if (!lang || !title) continue;
    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang).push({ qid: r.qid, title });
  }
  for (const [lang, arr] of byLang) {
    const batches = chunk(arr, 20);
    for (const [bi, b] of batches.entries()) {
      const titles = b.map((e) => e.title).join('|');
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&exlimit=20&redirects=1&titles=${encodeURIComponent(titles)}&format=json&origin=*`;
      const j = await getJson(url).catch(() => null);
      const pages = j ? Object.values(j.query?.pages ?? {}) : [];
      const norm = (t) => (t ?? '').replace(/_/g, ' ').trim();
      const byTitle = new Map(pages.map((p) => [norm(p.title), p.extract]));
      const alias = new Map();
      for (const n of j?.query?.normalized ?? []) alias.set(norm(n.from), norm(n.to));
      for (const rd of j?.query?.redirects ?? []) alias.set(norm(rd.from), norm(rd.to));
      for (const e of b) { let k = norm(e.title); k = alias.get(k) ?? k; const ex = byTitle.get(k); if (ex) cache.set(e.qid, { summary: ex, native_ru: lang === 'ru' }); }
      process.stdout.write(`\r  summary ${lang} ${bi + 1}/${batches.length}   `); await sleep(200);
    }
    save();
  }
  process.stdout.write('\n');
}

async function fetchPhotos(items, cache, save) {
  const withImg = items.filter((r) => r.image && !cache.has(r.qid)).map((r) => ({ qid: r.qid, file: r.image }));
  const strip = (h) => (h ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const norm = (t) => (t ?? '').replace(/_/g, ' ').trim().replace(/^File:/i, '');
  const batches = chunk(withImg, 50);
  for (const [bi, b] of batches.entries()) {
    const titles = b.map((e) => `File:${e.file}`).join('|');
    const url = `https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=96&iiextmetadatafilter=Artist|LicenseShortName|LicenseUrl&titles=${encodeURIComponent(titles)}&format=json&origin=*`;
    const j = await getJson(url).catch(() => null);
    const byFile = new Map();
    for (const p of Object.values(j?.query?.pages ?? {})) if (p.imageinfo?.[0]) byFile.set(norm(p.title), p.imageinfo[0]);
    for (const e of b) {
      const info = byFile.get(norm(`File:${e.file}`)); if (!info) continue;
      const m = info.extmetadata ?? {}; const author = strip(m.Artist?.value); const license = m.LicenseShortName?.value;
      if (!author || !license) continue; // без атрибуции фото не публикуем
      cache.set(e.qid, { image_url: info.url, thumb_url: info.thumburl ?? null, img_author: author, img_license: license, img_license_url: m.LicenseUrl?.value ?? null, img_source: info.descriptionurl });
    }
    process.stdout.write(`\r  photos ${bi + 1}/${batches.length}   `); await sleep(700);
    if (bi % 20 === 0) save();
  }
  process.stdout.write('\n'); save();
}

// --- main ---------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : d; };
  const region = arg('--region', 'europe');
  const min = Number(arg('--min', 5));
  const limit = argv.includes('--limit') ? Number(arg('--limit')) : Infinity;

  // читаем срез
  const items = [];
  const rl = createInterface({ input: createReadStream(resolve(ROOT, `data/eu/${region}.parsed.jsonl`)), crlfDelay: Infinity });
  for await (const line of rl) { if (!line) continue; let r; try { r = JSON.parse(line); } catch { continue; } if (r.sitelinks_count >= min) items.push(r); }
  const slice = Number.isFinite(limit) ? items.slice(0, limit) : items;
  console.log(`Срез sitelinks>=${min}: ${items.length}${Number.isFinite(limit) ? ` (limit ${slice.length})` : ''}`);

  const base = resolve(ROOT, `data/eu/${region}`);
  mkdirSync(resolve(ROOT, 'data/eu'), { recursive: true });
  const pv = loadCache(`${base}.enr-pageviews.json`); const svPv = () => saveCache(`${base}.enr-pageviews.json`, pv);
  const sm = loadCache(`${base}.enr-summary.json`); const svSm = () => saveCache(`${base}.enr-summary.json`, sm);
  const ph = loadCache(`${base}.enr-photos.json`); const svPh = () => saveCache(`${base}.enr-photos.json`, ph);

  console.log('→ pageviews…'); await fetchPageviews(slice, pv, svPv);
  console.log('→ summary (нативный ru + язык источника)…'); await fetchSummaries(slice, sm, svSm);
  console.log('→ photos (атрибуция + thumb)…'); await fetchPhotos(slice, ph, svPh);

  // merge → enriched.jsonl
  const out = resolve(ROOT, `data/eu/${region}.enriched.jsonl`);
  const ws = (await import('node:fs')).createWriteStream(out);
  for (const r of slice) {
    const s = sm.get(r.qid); const p = ph.get(r.qid);
    ws.write(JSON.stringify({
      ...r,
      pageviews_90d: pv.get(r.qid) ?? 0,
      summary: s?.summary ?? null,
      summary_native_ru: s?.native_ru ?? false,
      image_url: p?.image_url ?? null,
      thumb_url: p?.thumb_url ?? null,
      img_author: p?.img_author ?? null,
      img_license: p?.img_license ?? null,
      img_license_url: p?.img_license_url ?? null,
      img_source: p?.img_source ?? null,
    }) + '\n');
  }
  ws.end();
  console.log(`\nИтог: ${slice.length} обогащено`);
  console.log(`  pageviews>0: ${slice.filter((r) => (pv.get(r.qid) ?? 0) > 0).length}`);
  console.log(`  summary:     ${slice.filter((r) => sm.has(r.qid)).length}`);
  console.log(`  фото+атриб:  ${slice.filter((r) => ph.has(r.qid)).length}`);
  console.log(`Сохранено: data/eu/${region}.enriched.jsonl`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
}
