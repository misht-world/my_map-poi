// Юнит-тесты скоринга на выдуманных входных данных (CLAUDE.md шаг 1).
// Ноль сетевых вызовов. Запуск: `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  score,
  isEligible,
  scoreThresholdForZoom,
  DEFAULT_WEIGHTS,
  MIN_SITELINKS,
} from './score.mjs';

test('score следует формуле SPEC §3 при дефолтных весах', () => {
  const { w1, w2, w3 } = DEFAULT_WEIGHTS;
  const item = { sitelinks_count: 10, pageviews_90d: 1000, has_image: true };
  const expected =
    w1 * Math.log(10 + 1) + w2 * Math.log(1000 + 1) + w3 * 1;
  assert.ok(Math.abs(score(item) - expected) < 1e-12);
});

test('has_image добавляет ровно w3 к score', () => {
  const base = { sitelinks_count: 5, pageviews_90d: 200, has_image: false };
  const withImage = { ...base, has_image: true };
  assert.ok(
    Math.abs(score(withImage) - score(base) - DEFAULT_WEIGHTS.w3) < 1e-12,
  );
});

test('нулевые входы дают score 0', () => {
  assert.equal(score({ sitelinks_count: 0, pageviews_90d: 0, has_image: false }), 0);
});

test('score монотонно растёт по sitelinks и по pageviews', () => {
  const a = { sitelinks_count: 2, pageviews_90d: 100, has_image: false };
  const moreSitelinks = { ...a, sitelinks_count: 20 };
  const morePageviews = { ...a, pageviews_90d: 10000 };
  assert.ok(score(moreSitelinks) > score(a));
  assert.ok(score(morePageviews) > score(a));
});

test('log-шкала гасит рост: 10× sitelinks не даёт 10× вклада', () => {
  const w1 = DEFAULT_WEIGHTS.w1;
  const small = w1 * Math.log(10 + 1);
  const big = w1 * Math.log(100 + 1);
  assert.ok(big < small * 2); // сжатие тяжёлого хвоста городских объектов
});

test('кастомные веса переопределяют дефолт', () => {
  const item = { sitelinks_count: 3, pageviews_90d: 50, has_image: true };
  const zeroed = score(item, { w1: 0, w2: 0, w3: 0 });
  assert.equal(zeroed, 0);
});

test('мусорные/отсутствующие поля трактуются как 0, без NaN', () => {
  assert.equal(score({}), 0);
  assert.equal(score({ sitelinks_count: 'abc', pageviews_90d: null }), 0);
  assert.equal(score({ sitelinks_count: -5, pageviews_90d: -100 }), 0);
  assert.ok(Number.isFinite(score({ has_image: true })));
});

test('isEligible отсекает объекты без sitelinks', () => {
  assert.equal(isEligible({ sitelinks_count: 0 }), false);
  assert.equal(isEligible({}), false);
  assert.equal(isEligible({ sitelinks_count: MIN_SITELINKS }), true);
  assert.equal(isEligible({ sitelinks_count: 5 }), true);
});

test('scoreThresholdForZoom: выше zoom — ниже порог (плотнее карта)', () => {
  const far = scoreThresholdForZoom(6);
  const near = scoreThresholdForZoom(15);
  assert.ok(near < far);
});

test('scoreThresholdForZoom: ступенька берёт ближайший заданный zoom снизу', () => {
  // 6→6.0, 9→4.0 в конфиге: zoom 8 всё ещё на пороге zoom-стопа 6.
  assert.equal(scoreThresholdForZoom(8), scoreThresholdForZoom(6));
  // Ниже минимального стопа — берётся минимальный стоп.
  assert.equal(scoreThresholdForZoom(0), scoreThresholdForZoom(6));
});
