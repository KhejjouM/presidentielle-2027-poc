#!/usr/bin/env python3
"""Contrôle les mesures d'UN fichier sans rien écrire : pour chaque mesure, vérifie
le domaine officiel et cherche l'extrait sur la source, comme verify_measures.py.

Usage :
  python scripts/check_measures.py data/measures/<id>.json

Sortie : une ligne par mesure (statut, similarité) puis un bilan. Code 1 si une
mesure n'est pas "verifie".
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from urllib.parse import urldefrag

sys.path.insert(0, str(Path(__file__).resolve().parent))
import requests  # noqa: E402
from verify_measures import DATA, USER_AGENT, domain_allowed, extract_text, normalize, similarity  # noqa: E402


def main() -> int:
    path = Path(sys.argv[1])
    file = json.loads(path.read_text(encoding="utf-8"))
    meta = json.loads((DATA / "candidates.json").read_text(encoding="utf-8"))
    cand = next(c for c in meta["candidates"] if c["id"] == file["candidate_id"])
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    cache: dict[str, str | None] = {}
    bad = 0
    for m in file["measures"]:
        page, _ = urldefrag(m["source"]["url"])
        if not domain_allowed(page, cand["official_domains"], cand.get("official_documents")):
            status, score = "domaine_non_officiel", ""
        else:
            if page not in cache:
                try:
                    r = session.get(page, timeout=60)
                    cache[page] = normalize(extract_text(r)) if r.ok else None
                except requests.RequestException:
                    cache[page] = None
                time.sleep(0.5)
            text = cache[page]
            if text is None:
                status, score = "erreur_chargement", ""
            else:
                score = similarity(normalize(m["excerpt"]), text)
                status = "verifie" if score == 100.0 else "approchant" if score >= 85 else "introuvable"
        if status != "verifie":
            bad += 1
        print(f"{m['id']:<34} {status:<20} {score}")
    print(f"Bilan : {len(file['measures']) - bad} vérifiées sur {len(file['measures'])}")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
