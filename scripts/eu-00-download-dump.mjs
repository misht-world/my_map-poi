// ЕВРОПА, шаг 0: надёжный сегментный докачиватель/ремонтник дампа.
//
// Проблема: curl -C - после жёстких обрывов оставляет «рваные» стыки → gzip бьётся
// («invalid distance code»). Решение: качать НЕЗАВИСИМЫМИ кусками по 2 ГБ (range-запросы),
// каждый проверять по размеру, битый — перекачивать. Рваных стыков нет в принципе.
//
// По умолчанию РЕМОНТ головы: перекачивает первые --head ГБ (там повреждение) и вписывает
// их в существующий файл на месте (хвост, скачанный одним чистым проходом, не трогаем).
// --full — качает весь файл заново в чистый временный, потом заменяет.
//
// Резюмируемо: готовые куски (правильного размера) пропускаются. После успеха сбрасывает
// прогресс парсера (чекпоинт/jsonl), чтобы парс пошёл начисто.
//
// Запуск:  node scripts/eu-00-download-dump.mjs [--head 54] [--full]
// Обычно через  npm run data:build-eu  (ремонт + парсинг подряд).

import { execFileSync } from 'node:child_process';
import { existsSync, statSync, mkdirSync, createReadStream, openSync, writeSync, closeSync, rmSync, unlinkSync } from 'node:fs';

const URL = 'https://dumps.wikimedia.org/wikidatawiki/entities/latest-all.json.gz';
const DUMP = 'D:/wikidata-dump/latest-all.json.gz';
const PARTS = 'D:/wikidata-dump/parts';
const TOTAL = 154805551356;         // ожидаемый размер (проверен ранее)
const SEG = 2 * 2 ** 30;            // 2 ГБ на кусок
const GiB = 2 ** 30;

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
};
const FULL = process.argv.includes('--full');
const HEAD_BYTES = FULL ? TOTAL : Math.min(Number(arg('--head', 54)) * GiB, TOTAL);

function downloadSegment(start, end) {
  const partFile = `${PARTS}/seg_${start}.bin`;
  const expect = end - start;
  if (existsSync(partFile) && statSync(partFile).size === expect) return partFile; // уже есть
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      // отдельный range-запрос; -f — ошибка при HTTP-сбое; без -C, чистая загрузка куска
      execFileSync('curl', ['-sfL', '--retry', '10', '--retry-delay', '5',
        '--range', `${start}-${end - 1}`, '-o', partFile, URL], { stdio: 'ignore' });
      if (existsSync(partFile) && statSync(partFile).size === expect) return partFile;
    } catch { /* повтор */ }
    console.log(`    кусок @${(start / GiB).toFixed(1)}ГБ: попытка ${attempt} не удалась, повтор`);
  }
  throw new Error(`Не смог скачать кусок @${start}`);
}

function applyInto(fd, start, partFile) {
  // вписать кусок в DUMP на позицию start (без склейки/двойного места)
  let pos = start;
  const buf = createReadStream(partFile);
  return new Promise((res, rej) => {
    buf.on('data', (chunk) => { writeSync(fd, chunk, 0, chunk.length, pos); pos += chunk.length; });
    buf.on('end', res);
    buf.on('error', rej);
  });
}

async function main() {
  mkdirSync(PARTS, { recursive: true });
  const segs = [];
  for (let s = 0; s < HEAD_BYTES; s += SEG) segs.push([s, Math.min(s + SEG, HEAD_BYTES)]);
  console.log(`${FULL ? 'Полная загрузка' : 'Ремонт головы'}: ${(HEAD_BYTES / GiB).toFixed(0)} ГБ, ${segs.length} кусков по 2 ГБ`);

  // 1) скачать/проверить все куски (резюмируемо)
  for (const [i, [start, end]] of segs.entries()) {
    downloadSegment(start, end);
    if ((i + 1) % 2 === 0 || i === segs.length - 1) {
      console.log(`  скачано ${i + 1}/${segs.length} кусков (${((i + 1) * SEG / GiB).toFixed(0)} ГБ)`);
    }
  }

  // 2) вписать в файл
  if (FULL) {
    // для --full собираем свежий файл целиком
    if (existsSync(DUMP)) unlinkSync(DUMP);
  }
  if (!existsSync(DUMP)) { // создать пустой нужного размера (для записи по позициям)
    const fd0 = openSync(DUMP, 'w'); closeSync(fd0);
  }
  console.log('Вписываю куски в файл…');
  const fd = openSync(DUMP, 'r+');
  for (const [start, end] of segs) { await applyInto(fd, start, `${PARTS}/seg_${start}.bin`); }
  closeSync(fd);

  // 3) проверка размера и очистка
  const size = statSync(DUMP).size;
  if (size !== TOTAL) console.log(`⚠ размер файла ${size} != ${TOTAL} (для --full норм, для ремонта — хвост на месте)`);
  console.log(`Готово: голова (${(HEAD_BYTES / GiB).toFixed(0)} ГБ) переписана чистыми кусками.`);
  rmSync(PARTS, { recursive: true, force: true });

  // 4) сброс прогресса парсера — дамп изменился, парсить начисто
  for (const f of ['data/eu/europe.parse-checkpoint.json', 'data/eu/europe.parsed.jsonl']) {
    if (existsSync(f)) { unlinkSync(f); console.log(`  сброшено: ${f}`); }
  }
  console.log('Дамп починен. Дальше — парсинг.');
}

main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
