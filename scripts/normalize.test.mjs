// Юнит-тесты нормализации в GeoJSON без сети (CLAUDE.md). Запуск: `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toFeature, toFeatureCollection } from './04-normalize.mjs';

const base = {
  qid: 'Q52505',
  lat: 45.438,
  lon: 12.336,
  sitelinks_count: 52,
  label: 'Ponte di Rialto',
  description: 'ponte di Venezia',
  pageviews_90d: 8353,
  summary: 'Il ponte di Rialto…',
  wiki_url: 'https://it.wikipedia.org/wiki/Ponte_di_Rialto',
  image_url: 'https://upload.wikimedia.org/x.jpg',
  image_attribution: { author: 'kallerna', license: 'CC BY-SA 4.0', license_url: 'https://…', source: 'https://commons…' },
};

test('toFeature строит GeoJSON Point [lon, lat]', () => {
  const f = toFeature(base);
  assert.equal(f.type, 'Feature');
  assert.equal(f.geometry.type, 'Point');
  assert.deepEqual(f.geometry.coordinates, [12.336, 45.438]);
});

test('toFeature флатчит атрибуцию в плоские поля', () => {
  const p = toFeature(base).properties;
  assert.equal(p.img_author, 'kallerna');
  assert.equal(p.img_license, 'CC BY-SA 4.0');
  assert.equal(p.img_source, 'https://commons…');
  assert.equal(p.image_url, 'https://upload.wikimedia.org/x.jpg');
});

test('toFeature: без image_url все img_* обнуляются', () => {
  const p = toFeature({ ...base, image_url: null, image_attribution: null }).properties;
  assert.equal(p.image_url, null);
  assert.equal(p.img_author, null);
  assert.equal(p.img_license, null);
});

test('toFeature считает score и он растёт с sitelinks/pageviews', () => {
  const low = toFeature({ ...base, sitelinks_count: 2, pageviews_90d: 10, image_url: null, image_attribution: null }).properties.score;
  const high = toFeature(base).properties.score;
  assert.ok(high > low);
  assert.ok(Number.isFinite(low));
});

test('toFeature отбрасывает объекты без sitelinks (isEligible)', () => {
  assert.equal(toFeature({ ...base, sitelinks_count: 0 }), null);
});

test('toFeature пробрасывает is_religious (по умолчанию false)', () => {
  assert.equal(toFeature(base).properties.is_religious, false);
  assert.equal(toFeature({ ...base, is_religious: true }).properties.is_religious, true);
});

test('toFeatureCollection отфильтровывает негодные', () => {
  const fc = toFeatureCollection([base, { ...base, qid: 'Q0', sitelinks_count: 0 }]);
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 1);
  assert.equal(fc.features[0].properties.qid, 'Q52505');
});
