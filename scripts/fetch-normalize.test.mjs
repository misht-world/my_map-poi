// Юнит-тесты парсинга/нормализации fetch без сети (CLAUDE.md: каждый шаг проверяем).
// Вход — выдуманные SPARQL-биндинги в формате Wikidata. Запуск: `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePoint, normalizeBindings, buildQuery, gridCells } from './01-fetch-wikidata.mjs';

test('parsePoint разбирает WKT "Point(lon lat)"', () => {
  assert.deepEqual(parsePoint('Point(11.12 46.07)'), { lon: 11.12, lat: 46.07 });
  assert.deepEqual(parsePoint('Point(-1.5 -0.25)'), { lon: -1.5, lat: -0.25 });
});

test('parsePoint возвращает null на мусоре', () => {
  assert.equal(parsePoint(''), null);
  assert.equal(parsePoint(undefined), null);
  assert.equal(parsePoint('POLYGON((...))'), null);
});

test('buildQuery подставляет bbox и type-фильтр во ВСЕ вхождения плейсхолдеров', () => {
  const q = buildQuery({ west: 11.05, south: 46.02, east: 11.2, north: 46.12 });
  assert.ok(!q.includes('{{WEST}}'), 'остались неподставленные плейсхолдеры');
  assert.ok(!q.includes('{{NORTH}}'));
  assert.ok(!q.includes('{{WHITELIST}}'), 'whitelist не подставлен');
  assert.ok(!q.includes('{{BLACKLIST}}'), 'blacklist не подставлен');
  assert.ok(q.includes('Point(11.05 46.02)'));
  assert.ok(q.includes('Point(11.2 46.12)'));
  assert.ok(q.includes('wd:Q23413'), 'castle из whitelist попал в запрос');
  assert.ok(q.includes('wd:Q486972'), 'human settlement из blacklist попал в запрос');
});

test('gridCells покрывает регион и подрезает крайние клетки по границе', () => {
  const bbox = { west: 9.75, south: 45.15, east: 12.35, north: 46.75 };
  const cells = gridCells(bbox, 0.3);
  // ceil(2.6/0.3)=9 колонок × ceil(1.6/0.3)=6 строк
  assert.equal(cells.length, 54);
  // ни одна клетка не выходит за границы региона
  for (const c of cells) {
    assert.ok(c.east <= bbox.east + 1e-9 && c.north <= bbox.north + 1e-9);
    assert.ok(c.west >= bbox.west - 1e-9 && c.south >= bbox.south - 1e-9);
  }
  // первая клетка стартует в юго-западном углу
  assert.ok(Math.abs(cells[0].west - bbox.west) < 1e-9);
  assert.ok(Math.abs(cells[0].south - bbox.south) < 1e-9);
});

test('gridCells: одна клетка, если регион меньше cellSize', () => {
  const cells = gridCells({ west: 11.05, south: 46.02, east: 11.2, north: 46.12 }, 0.3);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].east, 11.2);
  assert.equal(cells[0].north, 46.12);
});

const binding = (over = {}) => ({
  item: { value: 'http://www.wikidata.org/entity/Q3376' },
  coord: { value: 'Point(11.12 46.07)' },
  sitelinks: { value: '114' },
  itemLabel: { value: 'Trento' },
  itemDescription: { value: 'comune italiano' },
  ...over,
});

test('normalizeBindings мапит поля и вытаскивает QID из URI', () => {
  const [item] = normalizeBindings({ results: { bindings: [binding({
    image: { value: 'http://commons.wikimedia.org/.../Trento.jpg' },
    commons: { value: 'Category:Trento' },
  })] } });
  assert.equal(item.qid, 'Q3376');
  assert.equal(item.lat, 46.07);
  assert.equal(item.lon, 11.12);
  assert.equal(item.sitelinks_count, 114);
  assert.equal(item.label, 'Trento');
  assert.equal(item.description, 'comune italiano');
  assert.ok(item.image.endsWith('Trento.jpg'));
  assert.equal(item.commons_category, 'Category:Trento');
});

test('дедуп по qid: несколько P18/P373 сливаются в один объект (первое непустое)', () => {
  const rows = {
    results: {
      bindings: [
        binding({ image: { value: 'img-A' }, commons: undefined }),
        binding({ image: { value: 'img-B' }, commons: { value: 'Category:Trento' } }),
      ],
    },
  };
  const items = normalizeBindings(rows);
  assert.equal(items.length, 1);
  assert.equal(items[0].image, 'img-A'); // первое непустое побеждает
  assert.equal(items[0].commons_category, 'Category:Trento'); // подтянулось из второй строки
});

test('строки без координат отбрасываются', () => {
  const items = normalizeBindings({
    results: { bindings: [binding({ coord: { value: 'not-a-point' } })] },
  });
  assert.equal(items.length, 0);
});

test('label, равный QID (fallback wikibase:label), считается пустым', () => {
  const [item] = normalizeBindings({
    results: { bindings: [binding({ itemLabel: { value: 'Q3376' } })] },
  });
  assert.equal(item.label, null);
});
