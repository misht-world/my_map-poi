// Скоринг значимости POI как чистая функция (SPEC §3, CLAUDE.md шаг 1).
//
//   score = w1 * log(sitelinks_count + 1)
//         + w2 * log(pageviews_90d + 1)
//         + w3 * (1 if has_image else 0)
//
// Никаких сетевых вызовов и I/O в самом расчёте — score()/isEligible() чистые,
// проверяемы на выдуманных входных данных. Веса тянутся из единственного
// конфиг-места config/scoring.json (магические числа не разбросаны по скриптам).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const configUrl = new URL('../config/scoring.json', import.meta.url);
const config = JSON.parse(readFileSync(fileURLToPath(configUrl), 'utf8'));

/** Веса по умолчанию из config/scoring.json. */
export const DEFAULT_WEIGHTS = Object.freeze({ ...config.weights });

/** Минимум sitelinks, чтобы объект вообще попал в карту (SPEC §3). */
export const MIN_SITELINKS = config.minSitelinks ?? 1;

/** Пороги score по zoom (для клиентского zoom-фильтра, SPEC §3). */
export const ZOOM_THRESHOLDS = Object.freeze({ ...config.zoomThresholds });

/**
 * Годен ли объект для карты. Объекты без единого sitelink отбрасываются
 * целиком (SPEC §3): это не «столбы и памятники», а неизвестные Wikidata точки,
 * которых на этой карте в принципе быть не должно.
 * @param {{ sitelinks_count?: number }} item
 * @returns {boolean}
 */
export function isEligible(item) {
  return toCount(item?.sitelinks_count) >= MIN_SITELINKS;
}

/**
 * Score значимости объекта. Чистая функция, детерминирована, без побочных эффектов.
 * @param {{ sitelinks_count?: number, pageviews_90d?: number, has_image?: boolean }} item
 * @param {{ w1: number, w2: number, w3: number }} [weights=DEFAULT_WEIGHTS]
 * @returns {number}
 */
export function score(item, weights = DEFAULT_WEIGHTS) {
  const { w1, w2, w3 } = weights;
  const sitelinks = toCount(item?.sitelinks_count);
  const pageviews = toCount(item?.pageviews_90d);
  const hasImage = item?.has_image ? 1 : 0;

  return w1 * Math.log(sitelinks + 1) + w2 * Math.log(pageviews + 1) + w3 * hasImage;
}

/**
 * Порог score для показа точки на данном zoom — ступенчато по ZOOM_THRESHOLDS
 * (ближайший заданный zoom, не превышающий текущий). Клиент позже заменит на
 * MapLibre interpolate, но логика порога живёт здесь, чтобы быть тестируемой.
 * @param {number} zoom
 * @returns {number}
 */
export function scoreThresholdForZoom(zoom) {
  const stops = Object.keys(ZOOM_THRESHOLDS)
    .map(Number)
    .sort((a, b) => a - b);
  let threshold = ZOOM_THRESHOLDS[stops[0]];
  for (const z of stops) {
    if (zoom >= z) threshold = ZOOM_THRESHOLDS[z];
  }
  return threshold;
}

/** Приводит вход к неотрицательному числу; мусор/undefined → 0. */
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
