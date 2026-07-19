// 04 — Normalize + score (CLAUDE.md шаг 4).
//
// Обогащённые объекты (шаг 3) → GeoJSON FeatureCollection с применением score() из
// src/score.mjs (шаг 1). Свойства фичи — ровно то, что нужно попапу (SPEC §5); maps_url
// генерится на клиенте из geometry, поэтому здесь его нет.
//
// Атрибуция фото флатчится в плоские строковые поля (img_author/img_license/…): вложенные
// объекты плохо переживают tippecanoe/векторные тайлы. Без атрибуции фото не публикуется —
// image_url в этом случае null (проверка уже сделана на шаге 3, здесь только переносим).
//
// Запуск: node scripts/04-normalize.mjs [--region name]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

import { score, isEligible } from '../src/score.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Обогащённый объект → GeoJSON Feature (или null, если не годен). */
export function toFeature(item) {
  if (!isEligible(item)) return null;
  const hasImage = Boolean(item.image_url);
  const attr = item.image_attribution ?? {};
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [item.lon, item.lat] },
    properties: {
      qid: item.qid,
      name: item.label ?? null,
      name_ru: item.name_ru ?? null,
      website: item.website ?? null,
      description: item.description ?? null,
      score: Number(score({ ...item, has_image: hasImage }).toFixed(4)),
      category: item.category ?? 'other',
      is_religious: Boolean(item.is_religious),
      ru_native: Boolean(item.ru_native),
      sitelinks_count: item.sitelinks_count,
      pageviews_90d: item.pageviews_90d ?? 0,
      summary: item.summary ?? null,
      wiki_url: item.wiki_url ?? null,
      image_url: hasImage ? item.image_url : null,
      img_author: hasImage ? attr.author ?? null : null,
      img_license: hasImage ? attr.license ?? null : null,
      img_license_url: hasImage ? attr.license_url ?? null : null,
      img_source: hasImage ? attr.source ?? null : null,
    },
  };
}

export function toFeatureCollection(items) {
  const features = items.map(toFeature).filter(Boolean);
  return { type: 'FeatureCollection', features };
}

function main() {
  const argv = process.argv.slice(2);
  const regions = JSON.parse(readFileSync(resolve(ROOT, 'config/regions.json'), 'utf8'));
  const ri = argv.indexOf('--region');
  const name = ri !== -1 && argv[ri + 1] && !argv[ri + 1].startsWith('--') ? argv[ri + 1] : regions.default;

  const src = resolve(ROOT, `data/enrich/${name}.enriched.json`);
  if (!existsSync(src)) throw new Error(`Нет ${src} — сначала шаг 3 (02-enrich)`);
  const items = JSON.parse(readFileSync(src, 'utf8'));

  // Категории (шаг 03-classify) — опционально. Задают цвет; is_religious = religion.
  const catFile = resolve(ROOT, `data/enrich/${name}.categories.json`);
  if (existsSync(catFile)) {
    const cats = JSON.parse(readFileSync(catFile, 'utf8'));
    for (const it of items) {
      it.category = cats[it.qid] ?? 'other';
      it.is_religious = it.category === 'religion';
    }
    const counts = {};
    for (const it of items) counts[it.category] = (counts[it.category] ?? 0) + 1;
    console.log('Категории:', counts);
  } else {
    console.log('⚠ Нет categories.json (03-classify) — category=other');
  }

  // Русская локализация (translate_ru.py) — опциональна. Заголовок (name) НЕ переводим —
  // оставляем оригинал, русское имя кладём отдельным полем name_ru (в попапе — мелким
  // серым под оригиналом). Описание и summary — по-русски.
  const ruFile = resolve(ROOT, `data/enrich/${name}.ru.json`);
  if (existsSync(ruFile)) {
    const ru = JSON.parse(readFileSync(ruFile, 'utf8'));
    let localized = 0;
    for (const it of items) {
      const r = ru[it.qid];
      if (!r) continue;
      // русское имя показываем, только если оно реально отличается от оригинала
      if (r.name_ru && r.name_ru !== it.label) it.name_ru = r.name_ru;
      if (r.description_ru) it.description = r.description_ru;
      if (r.summary_ru) it.summary = r.summary_ru;
      it.ru_native = Boolean(r.ru_native);
      localized++;
    }
    console.log(`Локализовано на русский: ${localized}/${items.length}`);
  } else {
    console.log('⚠ Нет ru.json (translate_ru.py) — текст на языке источника');
  }

  // Официальный сайт (P856, enrich-website.mjs) — опционально.
  const siteFile = resolve(ROOT, `data/enrich/${name}.website.json`);
  if (existsSync(siteFile)) {
    const sites = JSON.parse(readFileSync(siteFile, 'utf8'));
    for (const it of items) if (sites[it.qid]) it.website = sites[it.qid];
    console.log(`С сайтом: ${items.filter((i) => i.website).length}/${items.length}`);
  }

  const fc = toFeatureCollection(items);

  mkdirSync(resolve(ROOT, 'data/normalized'), { recursive: true });
  const out = resolve(ROOT, `data/normalized/${name}.geojson`);
  writeFileSync(out, JSON.stringify(fc));

  const scores = fc.features.map((f) => f.properties.score);
  scores.sort((a, b) => a - b);
  const pct = (p) => scores[Math.floor((scores.length - 1) * p)];
  const withPhoto = fc.features.filter((f) => f.properties.image_url).length;
  console.log(`Регион "${name}": features ${fc.features.length}`);
  console.log(`  score: min ${scores[0]?.toFixed(2)}  медиана ${pct(0.5)?.toFixed(2)}  p90 ${pct(0.9)?.toFixed(2)}  max ${scores.at(-1)?.toFixed(2)}`);
  console.log(`  с фото: ${withPhoto}/${fc.features.length}`);
  console.log('Топ-5 по score:');
  for (const f of [...fc.features].sort((a, b) => b.properties.score - a.properties.score).slice(0, 5)) {
    console.log(`  ${f.properties.score.toFixed(2)}  ${f.properties.name}`);
  }
  console.log(`Сохранено: data/normalized/${name}.geojson`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
