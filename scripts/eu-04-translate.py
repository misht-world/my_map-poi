#!/usr/bin/env python
"""ЕВРОПА, шаг 4: офлайн-перевод иноязычных summary на русский (argostranslate).

Читает data/eu/europe.enriched.jsonl. Нативные русские summary (summary_native_ru)
не трогает. Для остальных — MT через argos (пивот en), как в пилотном
translate_ru.py: если модели для языка нет или в выводе нет кириллицы, перевод
не сохраняется (пусто лучше чужого языка — решение зафиксировано на пилоте).

Результат — кэш data/eu/europe.tr-summary.json {qid: summary_ru | null}.
null = уже пробовали, модели нет; при перезапуске не повторяется (если доставил
модели — удали кэш или конкретные qid из него). Затем eu-02-normalize подхватит
кэш и подставит summary_ru вместо иноязычного текста.

ВНИМАНИЕ: только ASCII в stdout — консоль Windows (cp1252) на кириллице падает.

Очередь отсортирована по значимости (sitelinks_count убыв.) — прервёшь в любой момент,
самое важное уже переведено. Для ускорения можно шардировать на N параллельных окон
(перевод упирается в одно ядро CPU): --shard 1/3, 2/3, 3/3 — каждый шард пишет свой
кэш-файл (tr-summary.s1of3.json...), чужие кэши учитывает, дважды ничего не переводится.

Запуск:
  python scripts/eu-04-translate.py --limit 50     # проба
  python scripts/eu-04-translate.py                # весь срез одним процессом
  python scripts/eu-04-translate.py --shard 1/3    # окно 1 из 3 (и так же 2/3, 3/3)
"""
import glob, json, os, re, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAVE_EVERY = 200
CYR = re.compile(r"[А-Яа-яЁё]")


def log(msg):  # только ASCII
    sys.stdout.write(msg + "\n"); sys.stdout.flush()


def main():
    argv = sys.argv[1:]
    region = argv[argv.index("--region") + 1] if "--region" in argv else "europe"
    limit = int(argv[argv.index("--limit") + 1]) if "--limit" in argv else None
    shard_k, shard_n = 0, 1
    if "--shard" in argv:
        shard_k, shard_n = (int(x) for x in argv[argv.index("--shard") + 1].split("/"))
        assert 1 <= shard_k <= shard_n, "--shard K/N: 1 <= K <= N"

    src = os.path.join(ROOT, f"data/eu/{region}.enriched.jsonl")
    # done = все кэши (свой + чужих шардов + старый общий): дважды не переводим.
    done = {}
    for f in sorted(glob.glob(os.path.join(ROOT, f"data/eu/{region}.tr-summary*.json"))):
        done.update(json.load(open(f, encoding="utf-8")))
    if done:
        log(f"resume: {len(done)} qids already tried (all caches)")
    cache_file = os.path.join(ROOT, f"data/eu/{region}.tr-summary.json" if shard_n == 1
                              else f"data/eu/{region}.tr-summary.s{shard_k}of{shard_n}.json")
    cache = json.load(open(cache_file, encoding="utf-8")) if os.path.exists(cache_file) else {}

    todo = []
    with open(src, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            s = r.get("summary")
            if not s or r.get("summary_native_ru") or r["qid"] in done:
                continue
            if CYR.search(s):  # уже русский (редко, но бывает)
                continue
            todo.append((r["qid"], s, r.get("wiki_lang") or "en", r.get("sitelinks_count") or 0))
    # Сначала значимое: прерывание в любой момент оставляет главное переведённым.
    todo.sort(key=lambda t: -t[3])
    if shard_n > 1:
        todo = todo[shard_k - 1::shard_n]  # round-robin по отсортированному — каждый шард тоже "важное сначала"
        log(f"shard {shard_k}/{shard_n}")
    if limit:
        todo = todo[:limit]
    log(f"to translate: {len(todo)}")
    if not todo:
        log("nothing to do")
        return

    log("loading argostranslate (models load lazily per language)...")
    import argostranslate.translate as tr

    def mt(text, lang):
        try:
            out = tr.translate(text, lang, "ru")
            if out and CYR.search(out):
                return out
        except Exception:
            pass
        return None

    t0 = time.time()
    ok = 0
    for i, (qid, s, lang, _sl) in enumerate(todo, 1):
        res = mt(s, lang)
        cache[qid] = res
        if res:
            ok += 1
        if i % 50 == 0:
            rate = i / (time.time() - t0)
            eta_h = (len(todo) - i) / rate / 3600 if rate else 0
            log(f"  {i}/{len(todo)} ok={ok} ({rate:.1f}/s, ETA {eta_h:.1f}h)")
        if i % SAVE_EVERY == 0:
            json.dump(cache, open(cache_file, "w", encoding="utf-8"), ensure_ascii=False)

    json.dump(cache, open(cache_file, "w", encoding="utf-8"), ensure_ascii=False)
    log(f"done: {ok}/{len(todo)} translated (rest: no model for language)")
    log("saved: " + os.path.relpath(cache_file, ROOT).replace("\\", "/"))


if __name__ == "__main__":
    main()
