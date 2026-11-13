#!/usr/bin/env python3
"""Télécharge une page officielle (HTML ou PDF) et affiche son texte brut, tel que
verify_measures.py le lira. Sert à copier les extraits mot pour mot.

Usage :
  python scripts/fetch_text.py URL                 # texte complet
  python scripts/fetch_text.py URL --grep loyer    # lignes contenant un motif (regex, insensible à la casse)
  python scripts/fetch_text.py URL --links         # liens de la page (pour trouver les sous-pages du programme)
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import urljoin

sys.path.insert(0, str(Path(__file__).resolve().parent))
import requests  # noqa: E402
from bs4 import BeautifulSoup  # noqa: E402
from verify_measures import USER_AGENT, extract_text  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--grep")
    ap.add_argument("--links", action="store_true")
    args = ap.parse_args()
    r = requests.get(args.url, headers={"User-Agent": USER_AGENT}, timeout=60)
    print(f"# HTTP {r.status_code} {r.headers.get('content-type', '')} final_url={r.url}", file=sys.stderr)
    if args.links:
        soup = BeautifulSoup(r.text, "html.parser")
        seen = set()
        for a in soup.find_all("a", href=True):
            href = urljoin(r.url, a["href"]).split("#")[0]
            if href not in seen:
                seen.add(href)
                print(href, "|", " ".join(a.get_text(" ").split())[:80])
        return 0
    text = extract_text(r)
    text = re.sub(r"[ \t  ]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    if args.grep:
        pat = re.compile(args.grep, re.I)
        for line in text.splitlines():
            if pat.search(line):
                print(line.strip())
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
