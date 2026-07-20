#!/usr/bin/env python
"""Ставит офлайн-модели перевода (argostranslate) для нужных языков → русский.
Перевод идёт пивотом через английский, поэтому ставим X->en для исходных языков
+ en->ru. Недоступные пары пропускаются. Резюмируемо (уже стоящие пропускаются).
Запуск: python scripts/install_mt_models.py
"""
import sys, time
import argostranslate.package as pkg

# исходные языки статей, встречающиеся в данных (все пивотятся через en)
SRC = ["it", "de", "fr", "es", "pt", "nl", "pl", "cs", "ro", "ja", "sv", "uk",
       "sh", "et", "ca", "fi", "da", "hu", "el", "tr", "sl", "sk"]


def retry(fn, n=4):
    for i in range(n):
        try:
            return fn()
        except Exception as e:
            sys.stdout.write(f"  retry {i+1}: {str(e)[:50]}\n"); sys.stdout.flush(); time.sleep(3)
    raise SystemExit("gave up updating index")


retry(pkg.update_package_index)
avail = pkg.get_available_packages()
installed = {(p.from_code, p.to_code) for p in pkg.get_installed_packages()}

pairs = [(s, "en") for s in SRC] + [("en", "ru")]
ok, miss, skip = [], [], []
for frm, to in pairs:
    if (frm, to) in installed:
        skip.append(f"{frm}>{to}"); continue
    p = next((x for x in avail if x.from_code == frm and x.to_code == to), None)
    if not p:
        miss.append(f"{frm}>{to}"); continue
    try:
        retry(lambda: pkg.install_from_path(p.download())); ok.append(f"{frm}>{to}")
    except SystemExit:
        miss.append(f"{frm}>{to}")

sys.stdout.write(f"installed: {' '.join(ok) or '-'}\n")
sys.stdout.write(f"already:   {' '.join(skip) or '-'}\n")
sys.stdout.write(f"missing:   {' '.join(miss) or '-'}\n")
sys.stdout.flush()
