// ЕВРОПА, шаг 2: normalize распарсенного дампа → GeoJSONSeq для tippecanoe.
//
// Из europe.parsed.jsonl (парсер дал имя/ру-имя/описание/категорию/координаты/фото/сайт/вики)
// считает score (по числу реальных Википедий + наличию фото; просмотры добавит enrich позже)
// и пишет построчный GeoJSON (одна фича на строку) — так tippecanoe читает 514k эффективно.
// Фото в попапе пока НЕ показываем (нет атрибуции — политика CLAUDE.md; будет на enrich).
//
// Запуск: node scripts/eu-02-normalize.mjs [--region europe]

import { createReadStream, createWriteStream, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { score } from '../src/score.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const wikiUrl = (r) => {
  if (r.ru_title) return `https://ru.wikipedia.org/wiki/${encodeURIComponent(r.ru_title.replace(/ /g, '_'))}`;
  if (r.wiki_lang && r.wiki_title) return `https://${r.wiki_lang}.wikipedia.org/wiki/${encodeURIComponent(r.wiki_title.replace(/ /g, '_'))}`;
  return null;
};

async function main() {
  const argv = process.argv.slice(2);
  const ri = argv.indexOf('--region');
  const name = ri !== -1 && argv[ri + 1] && !argv[ri + 1].startsWith('--') ? argv[ri + 1] : 'europe';

  const src = resolve(ROOT, `data/eu/${name}.parsed.jsonl`);
  const outFile = resolve(ROOT, `data/eu/${name}.geojsonseq`);
  const out = createWriteStream(outFile);
  const seen = new Set();

  // Обогащённые поля (eu-03-enrich, срез) — накладываются поверх парса, если есть.
  const enr = new Map();
  const enrFile = resolve(ROOT, `data/eu/${name}.enriched.jsonl`);
  if (existsSync(enrFile)) {
    const erl = createInterface({ input: createReadStream(enrFile), crlfDelay: Infinity });
    for await (const line of erl) { if (!line) continue; try { const e = JSON.parse(line); enr.set(e.qid, e); } catch {} }
    console.log(`Обогащённых наложено: ${enr.size}`);
  }
  // Переводы summary (eu-04-translate.py) — подменяют иноязычный текст, нативный ru не трогают.
  // Кэшей может быть несколько (шарды tr-summary.s1of3.json...) — сливаем все.
  let trSum = {};
  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync(resolve(ROOT, 'data/eu')).filter((f) => f.startsWith(`${name}.tr-summary`) && f.endsWith('.json')).sort()) {
    Object.assign(trSum, JSON.parse(readFileSync(resolve(ROOT, 'data/eu', f), 'utf8')));
  }
  const trOk = Object.values(trSum).filter(Boolean).length;
  if (trOk) console.log(`Переводов summary наложено: ${trOk}`);
  const catCount = {};
  let n = 0;

  const rl = createInterface({ input: createReadStream(src), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (seen.has(r.qid)) continue; // дедуп по qid (границы чекпоинта)
    seen.add(r.qid);

    const hasImage = Boolean(r.image);
    // score — по числу Википедий (единая шкала 0–6 для всех 514k); просмотры идут в размер, не в score.
    const s = Number(score({ sitelinks_count: r.sitelinks_count, pageviews_90d: 0, has_image: hasImage }).toFixed(3));
    const nameRu = r.label_ru && r.label_ru !== r.label ? r.label_ru : null;
    const e = enr.get(r.qid); // обогащение (просмотры/summary/фото), если есть

    const feature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
      properties: {
        qid: r.qid,
        name: r.label || r.qid,
        name_ru: nameRu,
        category: r.category,
        score: s,
        sitelinks_count: r.sitelinks_count,
        pageviews_90d: e?.pageviews_90d ?? 0,
        has_image: hasImage,
        description: r.description_ru || null,
        // приоритет: нативный ru → машинный перевод → текст на языке источника
        summary: (e?.summary_native_ru ? e.summary : null) || trSum[r.qid] || e?.summary || null,
        website: r.website || null,
        wiki_url: wikiUrl(r),
        image_url: e?.image_url || null,
        thumb_url: e?.thumb_url || null,
        img_author: e?.img_author || null,
        img_license: e?.img_license || null,
        img_license_url: e?.img_license_url || null,
        img_source: e?.img_source || null,
      },
    };
    out.write(JSON.stringify(feature) + '\n');
    catCount[r.category] = (catCount[r.category] || 0) + 1;
    n++;
  }
  out.end();
  await new Promise((res) => out.on('finish', res));

  // gzip для заливки в релиз europe-src (вход тайлинга) — одной командой.
  await new Promise((res, rej) => {
    createReadStream(outFile).pipe(createGzip()).pipe(createWriteStream(outFile + '.gz')).on('finish', res).on('error', rej);
  });

  mkdirSync(resolve(ROOT, 'data/eu'), { recursive: true });
  const meta = {
    built: new Date().toISOString().slice(0, 10),
    region: name,
    count: n,
    sources: 'Wikidata (CC0), Wikipedia (CC BY-SA), Wikimedia Commons',
  };
  writeFileSync(resolve(ROOT, `data/eu/${name}.meta.json`), JSON.stringify(meta));
  // Копия для сайта (маленькая, коммитится и деплоится с web/).
  writeFileSync(resolve(ROOT, `web/${name}-meta.json`), JSON.stringify(meta));

  console.log(`Регион "${name}": ${n} фич`);
  console.log('по категориям:', JSON.stringify(catCount));
  console.log(`Сохранено: data/eu/${name}.geojsonseq (+ ${name}.meta.json)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
}
