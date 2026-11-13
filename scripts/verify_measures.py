#!/usr/bin/env python3
"""Vérifie que chaque mesure figure toujours sur la source officielle citée.

Pour chaque mesure :
  1. contrôle que l'URL source appartient aux domaines officiels du candidat ;
  2. télécharge la page (HTML ou PDF) et en extrait le texte ;
  3. cherche l'extrait mot pour mot, puis par similarité approchée ;
  4. enregistre le statut, la date, l'empreinte de la page et, avec --archive,
     une copie sur la Wayback Machine.

Résultat : data/verification.json, lu par le site.

Usage :
  python scripts/verify_measures.py            # contrôle tout
  python scripts/verify_measures.py --archive  # contrôle et archive les pages
  python scripts/verify_measures.py --only demo-a-sante-01
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urldefrag, urlparse

import requests
from bs4 import BeautifulSoup
from rapidfuzz import fuzz

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUTPUT = DATA / "verification.json"

USER_AGENT = "Programmes2027-Verification/0.1 (outil citoyen open source)"
# "verifie" exige le texte identique (après normalisation des espaces, accents et apostrophes).
# Un seul chiffre changé suffit donc à rétrograder la mesure en "approchant".
THRESHOLD_CLOSE = 85
DELAY_BETWEEN_REQUESTS = 1.0  # politesse envers les sites des partis


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.lower()
    text = re.sub(r"[’‘`´]", "'", text)
    text = re.sub(r"[«»“”]", '"', text)
    text = re.sub(r"[\u2010-\u2015]", "-", text)  # tous les tirets typographiques deviennent "-"
    text = text.replace("\u00a0", " ").replace("\u202f", " ")
    return re.sub(r"\s+", " ", text).strip()


def domain_allowed(url: str, domains: list[str]) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return any(host == d or host.endswith("." + d) for d in domains)


def extract_text(response: requests.Response) -> str:
    content_type = response.headers.get("content-type", "").lower()
    if "pdf" in content_type or response.url.lower().endswith(".pdf"):
        import pdfplumber

        with pdfplumber.open(io.BytesIO(response.content)) as pdf:
            return "\n".join(page.extract_text() or "" for page in pdf.pages)
    if "charset" not in content_type:
        response.encoding = response.apparent_encoding or "utf-8"
    soup = BeautifulSoup(response.text, "html.parser")
    for tag in soup(["script", "style", "noscript", "nav", "footer", "header"]):
        tag.decompose()
    return soup.get_text(" ")


def similarity(excerpt: str, page: str) -> float:
    if not excerpt:
        return 0.0
    if excerpt in page:
        return 100.0
    return round(fuzz.partial_ratio(excerpt, page), 1)


def archive(url: str, session: requests.Session) -> str | None:
    try:
        r = session.get(f"https://web.archive.org/save/{url}", timeout=90)
        if r.ok:
            location = r.headers.get("content-location")
            return f"https://web.archive.org{location}" if location else r.url
    except requests.RequestException:
        pass
    return None


def load_measures() -> list[tuple[dict, dict]]:
    meta = json.loads((DATA / "candidates.json").read_text(encoding="utf-8"))
    pairs = []
    for cand in meta["candidates"]:
        file = json.loads((ROOT / cand["measures_file"]).read_text(encoding="utf-8"))
        for m in file["measures"]:
            pairs.append((cand, m))
    return pairs


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--archive", action="store_true", help="archiver chaque page sur la Wayback Machine")
    parser.add_argument("--only", nargs="*", help="identifiants de mesures à contrôler")
    args = parser.parse_args()

    previous = {}
    if OUTPUT.exists():
        previous = json.loads(OUTPUT.read_text(encoding="utf-8")).get("results", {})

    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    page_cache: dict[str, tuple[str | None, int | None, str | None]] = {}
    archive_cache: dict[str, str | None] = {}
    results = dict(previous)
    counts: dict[str, int] = {}

    for cand, m in load_measures():
        if args.only and m["id"] not in args.only:
            continue
        if cand.get("demo"):
            # Les données de démonstration gardent leur statut fictif.
            results.setdefault(m["id"], {"status": "demo", "demo": True})
            continue

        url = m["source"]["url"]
        page_url, _ = urldefrag(url)
        entry: dict = {"url": url, "checked_at": now_iso()}

        if not domain_allowed(page_url, cand["official_domains"]):
            entry["status"] = "domaine_non_officiel"
        else:
            if page_url not in page_cache:
                try:
                    r = session.get(page_url, timeout=45)
                    text = normalize(extract_text(r)) if r.ok else None
                    page_cache[page_url] = (text, r.status_code, None)
                except requests.RequestException as exc:
                    page_cache[page_url] = (None, None, str(exc)[:200])
                time.sleep(DELAY_BETWEEN_REQUESTS)

            text, http_status, error = page_cache[page_url]
            entry["http_status"] = http_status
            if text is None:
                entry["status"] = "erreur"
                if error:
                    entry["error"] = error
                # On garde la trace du dernier contrôle réussi.
                last_ok = previous.get(m["id"], {})
                if last_ok.get("status") in {"verifie", "approchant"}:
                    entry["last_success_at"] = last_ok.get("checked_at")
            else:
                excerpt = normalize(m["excerpt"])
                score = similarity(excerpt, text)
                entry["similarity"] = score
                entry["status"] = "verifie" if score == 100.0 else "approchant" if score >= THRESHOLD_CLOSE else "introuvable"
                missing_numbers = [n for n in re.findall(r"\d+(?:[.,]\d+)?", excerpt) if n not in text]
                if missing_numbers:
                    entry["chiffres_absents"] = missing_numbers
                digest = hashlib.sha256(text.encode()).hexdigest()
                entry["page_sha256"] = digest
                old = previous.get(m["id"], {})
                if old.get("page_sha256") and old["page_sha256"] != digest:
                    entry["page_changed_since"] = old.get("checked_at")
                if args.archive and entry["status"] in {"verifie", "approchant"}:
                    if page_url not in archive_cache:
                        archive_cache[page_url] = archive(page_url, session)
                    entry["archive_url"] = archive_cache[page_url] or old.get("archive_url")
                else:
                    entry["archive_url"] = old.get("archive_url")

        results[m["id"]] = entry
        counts[entry["status"]] = counts.get(entry["status"], 0) + 1
        print(f"{m['id']:<28} {entry['status']:<22} {entry.get('similarity', '')}")

    known_ids = {m["id"] for _, m in load_measures()}
    results = {k: v for k, v in results.items() if k in known_ids}

    OUTPUT.write_text(
        json.dumps({"generated_at": now_iso(), "results": results}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print("Bilan :", counts or "aucune mesure réelle à contrôler")
    return 0


if __name__ == "__main__":
    sys.exit(main())
