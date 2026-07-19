// Юнит-тесты чистых хелперов enrich без сети (CLAUDE.md). Запуск: `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractFilename, stripHtml, chooseSitelink } from './02-enrich.mjs';

test('extractFilename декодирует имя файла из Special:FilePath URL', () => {
  assert.equal(
    extractFilename('http://commons.wikimedia.org/wiki/Special:FilePath/Rialto%202025%204.jpg'),
    'Rialto 2025 4.jpg',
  );
  assert.equal(extractFilename(null), null);
  assert.equal(extractFilename('http://example.org/nope'), null);
});

test('stripHtml убирает разметку и схлопывает пробелы (поле Artist)', () => {
  assert.equal(stripHtml('<a href="/wiki/User:X">kallerna</a>'), 'kallerna');
  assert.equal(stripHtml('  <b>A</b>\n  B  '), 'A B');
  assert.equal(stripHtml(null), '');
});

test('chooseSitelink предпочитает it > de > en', () => {
  const sl = {
    dewiki: { title: 'Rialtobrücke' },
    enwiki: { title: 'Rialto Bridge' },
    itwiki: { title: 'Ponte di Rialto' },
  };
  assert.deepEqual(chooseSitelink(sl), { lang: 'it', title: 'Ponte di Rialto' });
});

test('chooseSitelink: de как fallback без итальянского (Южный Тироль)', () => {
  const sl = { dewiki: { title: 'Schloss Tirol' }, enwiki: { title: 'Tirol Castle' } };
  assert.deepEqual(chooseSitelink(sl), { lang: 'de', title: 'Schloss Tirol' });
});

test('chooseSitelink: любая википедия, если нет it/de/en', () => {
  const sl = { frwiki: { title: 'Truc' }, commonswiki: { title: 'Category:Truc' } };
  assert.deepEqual(chooseSitelink(sl), { lang: 'fr', title: 'Truc' });
});

test('chooseSitelink игнорирует не-википедийные проекты', () => {
  const sl = { commonswiki: { title: 'Category:X' }, specieswiki: { title: 'X' } };
  assert.equal(chooseSitelink(sl), null);
});
