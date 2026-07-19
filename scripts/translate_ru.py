#!/usr/bin/env python
"""Русская локализация объектов (гибрид: нативный ru + офлайн машинный перевод).

Для каждого qid из enriched.json формирует name_ru / description_ru / summary_ru:
  - name_ru:        русский label из Wikidata, иначе MT(label)
  - description_ru: русское description из Wikidata, иначе MT(description)
  - summary_ru:     summary из ru.wikipedia (если есть статья), иначе MT(summary)
Источник MT — argostranslate (офлайн, бесплатно, без API/лимитов), пивот через
английский (it/de/... -> en -> ru). Нативный русский предпочитается — он качественнее.

Резюмируемо: результат пишется в data/enrich/<region>.ru.json порциями; повторный
запуск дотягивает только отсутствующие qid. ВНИМАНИЕ: только UTF-8 файлы, никакого
Unicode в stdout — консоль Windows (cp1252) на кириллице падает.

Запуск: python scripts/translate_ru.py [--region NAME] [--limit N]
"""
import json, os, re, sys, time
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = {"User-Agent": "my_map-poi/0.0 (https://github.com/misht-world/my_map-poi; misht.world@gmail.com)"}
SAVE_EVERY = 200


def log(msg):  # только ASCII в stdout
    sys.stdout.write(msg + "\n"); sys.stdout.flush()


def src_lang(wiki_url):
    m = re.search(r"https://([a-z-]+)\.wikipedia", wiki_url or "")
    return m.group(1) if m else "en"


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def get_json(url, retries=4):
    for a in range(retries):
        try:
            r = requests.get(url, headers=UA, timeout=30)
            if r.ok:
                return r.json()
        except Exception:
            pass
        time.sleep(1.5 * (a + 1))
    return {}


def fetch_native(qids):
    """qid -> {ru_label, ru_desc, ruwiki_title} (батч wbgetentities по 50)."""
    native = {}
    batches = list(chunks(qids, 50))
    for bi, batch in enumerate(batches):
        url = ("https://www.wikidata.org/w/api.php?action=wbgetentities&ids=" +
               "|".join(batch) +
               "&props=labels|descriptions|sitelinks&languages=ru&sitefilter=ruwiki&format=json&origin=*")
        j = get_json(url)
        for q in batch:
            e = j.get("entities", {}).get(q, {})
            native[q] = {
                "ru_label": e.get("labels", {}).get("ru", {}).get("value"),
                "ru_desc": e.get("descriptions", {}).get("ru", {}).get("value"),
                "ruwiki_title": e.get("sitelinks", {}).get("ruwiki", {}).get("title"),
            }
        log(f"  native wbgetentities {bi + 1}/{len(batches)}")
        time.sleep(0.15)
    return native


def fetch_ru_summaries(title_by_qid):
    """qid -> summary из ru.wikipedia (Action API extracts, батч по 20 titles)."""
    out = {}
    items = list(title_by_qid.items())
    batches = list(chunks(items, 20))
    for bi, batch in enumerate(batches):
        titles = "|".join(t for _, t in batch)
        url = ("https://ru.wikipedia.org/w/api.php?action=query&prop=extracts"
               "&exintro=1&explaintext=1&exlimit=20&redirects=1&titles=" +
               requests.utils.quote(titles) + "&format=json&origin=*")
        j = get_json(url)
        pages = j.get("query", {}).get("pages", {})
        by_title = {p.get("title", "").replace("_", " "): p.get("extract")
                    for p in pages.values()}
        alias = {}
        for n in j.get("query", {}).get("normalized", []):
            alias[n["from"].replace("_", " ")] = n["to"].replace("_", " ")
        for rd in j.get("query", {}).get("redirects", []):
            alias[rd["from"].replace("_", " ")] = rd["to"].replace("_", " ")
        for qid, title in batch:
            key = title.replace("_", " ")
            key = alias.get(key, key)
            ex = by_title.get(key)
            if ex:
                out[qid] = ex
        log(f"  ru.summary extracts {bi + 1}/{len(batches)}")
        time.sleep(0.15)
    return out


def main():
    argv = sys.argv[1:]
    regions = json.load(open(os.path.join(ROOT, "config/regions.json"), encoding="utf-8"))
    name = regions["default"]
    if "--region" in argv:
        name = argv[argv.index("--region") + 1]
    limit = int(argv[argv.index("--limit") + 1]) if "--limit" in argv else None

    src = os.path.join(ROOT, f"data/enrich/{name}.enriched.json")
    items = json.load(open(src, encoding="utf-8"))
    if limit:
        items = items[:limit]
    log(f'region "{name}": {len(items)} items to localize')

    out_file = os.path.join(ROOT, f"data/enrich/{name}.ru.json")
    result = {}
    if os.path.exists(out_file):
        result = json.load(open(out_file, encoding="utf-8"))
        log(f"resume: {len(result)} already done")

    todo = [i for i in items if i["qid"] not in result]
    if not todo:
        log("nothing to do")
        return
    qids = [i["qid"] for i in todo]

    # 1) нативный русский
    log("fetching native ru (Wikidata labels/descriptions + ruwiki)...")
    native = fetch_native(qids)
    ruwiki_titles = {q: native[q]["ruwiki_title"] for q in qids if native.get(q, {}).get("ruwiki_title")}
    log(f"  objects with ru.wikipedia article: {len(ruwiki_titles)}")
    ru_summaries = fetch_ru_summaries(ruwiki_titles) if ruwiki_titles else {}

    # 2) машинный перевод пробелов (модели грузятся один раз)
    log("loading argostranslate...")
    import argostranslate.translate as tr

    def mt(text, lang):
        if not text:
            return None
        try:
            return tr.translate(text, lang, "ru")
        except Exception:
            return text  # не роняем прогон — оставляем оригинал

    log("translating gaps (may take ~40+ min for full region)...")
    processed = 0
    n_native_name = n_native_desc = n_native_sum = 0
    for it in todo:
        q = it["qid"]
        lang = src_lang(it.get("wiki_url"))
        nat = native.get(q, {})

        if nat.get("ru_label"):
            name_ru = nat["ru_label"]; n_native_name += 1
        else:
            name_ru = mt(it.get("label"), lang)

        if nat.get("ru_desc"):
            desc_ru = nat["ru_desc"]; n_native_desc += 1
        elif it.get("description"):
            desc_ru = mt(it["description"], lang)
        else:
            desc_ru = None

        if q in ru_summaries:
            sum_ru = ru_summaries[q]; n_native_sum += 1
        elif it.get("summary"):
            sum_ru = mt(it["summary"], lang)
        else:
            sum_ru = None

        result[q] = {
            "name_ru": name_ru,
            "description_ru": desc_ru,
            "summary_ru": sum_ru,
            "ru_native": bool(nat.get("ru_label") or q in ru_summaries),
        }
        processed += 1
        if processed % SAVE_EVERY == 0:
            json.dump(result, open(out_file, "w", encoding="utf-8"), ensure_ascii=False)
            log(f"  {processed}/{len(todo)} (saved)")

    json.dump(result, open(out_file, "w", encoding="utf-8"), ensure_ascii=False)
    log(f"done: {len(result)} total | native name {n_native_name}, desc {n_native_desc}, summary {n_native_sum}")
    log(f"saved: data/enrich/{name}.ru.json")


if __name__ == "__main__":
    main()
