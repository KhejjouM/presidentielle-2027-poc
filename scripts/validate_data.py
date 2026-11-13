#!/usr/bin/env python3
"""Contrôle la cohérence des données avant publication.

Bloque (code de sortie 1) si :
  - une mesure n'a pas d'extrait mot pour mot ou pas de source ;
  - la source n'appartient pas aux domaines officiels du candidat ;
  - un critère de l'indice utilise une valeur inconnue ou manque de source ;
  - un identifiant est dupliqué ;
  - un texte contient un tiret long ;
  - les candidats n'ont pas tous été traités avec la même grille.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
REQUIRED = ["id", "theme", "title", "summary", "excerpt", "source"]
MIN_EXCERPT = 30


def walk_strings(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from walk_strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from walk_strings(v)


def main() -> int:
    errors: list[str] = []
    warnings: list[str] = []
    meta = json.loads((DATA / "candidates.json").read_text(encoding="utf-8"))
    grid = json.loads((DATA / "credibility.json").read_text(encoding="utf-8"))
    themes = json.loads((DATA / "themes.json").read_text(encoding="utf-8"))
    criteria = {c["id"]: c for c in grid["criteria"]}
    seen: set[str] = set()

    for name in ["candidates.json", "credibility.json", "themes.json"]:
        if any("\u2014" in s for s in walk_strings(json.loads((DATA / name).read_text(encoding="utf-8")))):
            errors.append(f"{name} : tiret long interdit")

    cand_ids = set()
    for cand in meta["candidates"]:
        if cand["id"] in cand_ids:
            errors.append(f"candidat dupliqué : {cand['id']}")
        cand_ids.add(cand["id"])
        if not cand.get("official_domains") and cand.get("program_status") in {"programme", "propositions"}:
            errors.append(f"{cand['id']} : aucun domaine officiel déclaré")
        if not cand.get("demo"):
            # Règle d'inclusion : déclaration rapportée par au moins deux médias nationaux distincts.
            hosts = {(urlparse(u).hostname or "").removeprefix("www.") for u in cand.get("declaration_sources", [])}
            if len(hosts) < 2:
                errors.append(f"{cand['id']} : il faut deux sources de presse distinctes pour la déclaration")
            if cand.get("program_status") not in {"programme", "propositions", "aucun", "inaccessible"}:
                errors.append(f"{cand['id']} : program_status invalide ({cand.get('program_status')})")
            if cand.get("program_status") in {"programme", "propositions"} and not cand.get("program_url"):
                errors.append(f"{cand['id']} : program_url manquant alors qu'un programme est déclaré")
            if cand.get("program_url"):
                host = (urlparse(cand["program_url"]).hostname or "").lower()
                if cand["program_url"] not in cand.get("official_documents", []) and not any(host == d or host.endswith("." + d) for d in cand.get("official_domains", [])):
                    errors.append(f"{cand['id']} : program_url hors des domaines officiels ({host})")
        path = ROOT / cand["measures_file"]
        if not path.exists():
            errors.append(f"{cand['id']} : fichier {cand['measures_file']} absent")
            continue
        file = json.loads(path.read_text(encoding="utf-8"))
        if file.get("candidate_id") != cand["id"]:
            errors.append(f"{path.name} : candidate_id ne correspond pas à {cand['id']}")
        if not file["measures"] and cand.get("program_status") in {"programme", "propositions"}:
            warnings.append(f"{cand['id']} : aucune mesure (programme pas encore publié ?)")

        for m in file["measures"]:
            where = f"{cand['id']}/{m.get('id', '?')}"
            for field in REQUIRED:
                if not m.get(field):
                    errors.append(f"{where} : champ obligatoire manquant '{field}'")
            if m.get("id") in seen:
                errors.append(f"{where} : identifiant dupliqué")
            seen.add(m.get("id"))
            if len(m.get("excerpt", "")) < MIN_EXCERPT:
                errors.append(f"{where} : extrait trop court pour être vérifiable (min {MIN_EXCERPT} caractères)")
            if m.get("theme") not in themes:
                warnings.append(f"{where} : thème '{m.get('theme')}' absent de themes.json")
            url = m.get("source", {}).get("url", "")
            host = (urlparse(url).hostname or "").lower()
            page = url.split("#")[0]
            if page not in cand.get("official_documents", []) and not any(host == d or host.endswith("." + d) for d in cand.get("official_domains", [])):
                errors.append(f"{where} : source hors des domaines officiels ({host})")
            if any("\u2014" in s for s in walk_strings(m)):
                errors.append(f"{where} : tiret long interdit")

            for crit_id, entry in (m.get("credibility") or {}).items():
                crit = criteria.get(crit_id)
                if not crit:
                    errors.append(f"{where} : critère inconnu '{crit_id}'")
                    continue
                if entry.get("value") not in crit["values"]:
                    errors.append(f"{where} : valeur '{entry.get('value')}' invalide pour {crit_id}")
                if crit.get("requires_source") and not entry.get("source_url"):
                    errors.append(f"{where} : {crit_id} exige une source (source_url)")

    for w in warnings:
        print("Avertissement :", w)
    for e in errors:
        print("Erreur :", e)
    print(f"{len(seen)} mesures, {len(cand_ids)} candidats, {len(errors)} erreurs, {len(warnings)} avertissements")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
