# Instructions pour Claude Code

## Le projet

Site statique (GitHub Pages) qui aide un électeur à retrouver, dans chaque programme officiel de la présidentielle 2027, les mesures liées à sa situation. Chaque mesure affiche sa source exacte, un statut de vérification automatique sur le site du candidat, et un indice de solidité dont la grille est publique.

Le site ne recommande jamais un candidat. C'est la contrainte qui prime sur toutes les autres.

## Règles non négociables

1. **Aucune mesure inventée.** Chaque mesure a un champ `excerpt` copié mot pour mot depuis la source officielle. Si tu ne peux pas copier le texte exact, n'ajoute pas la mesure.
2. **Sources officielles uniquement.** L'URL `source.url` d'une mesure doit appartenir à un domaine listé dans `official_domains` du candidat (site de campagne ou du parti). Les médias, Wikipédia et les comparateurs tiers ne sont pas des sources de mesures.
3. **Égalité de traitement.** Même grille, même niveau de détail, même effort d'extraction pour chaque candidat. Ne traite pas un programme plus finement qu'un autre. Si un programme n'est pas encore publié, le fichier de mesures reste vide.
4. **Indice de solidité : uniquement des faits sourcés.** Un critère n'est renseigné que s'il existe un élément vérifiable (`source_url` obligatoire sauf pour `precision`, qui se lit dans l'extrait). Sans source, on omet le critère : il ne compte ni pour ni contre. Tu ne déduis jamais une valeur de ton propre jugement.
5. **Aucun tiret long (le caractère U+2014)** nulle part : code, données, textes, commits. `scripts/validate_data.py` le bloque dans les données.
6. **Aucune collecte.** Pas de cookie, pas d'outil d'audience, pas de stockage du texte saisi par l'utilisateur, pas de backend qui journalise les requêtes. Les opinions politiques sont des données sensibles (RGPD, article 9).
7. **Le titre et le résumé reformulent l'extrait sans le déformer.** Pas d'adjectif évaluatif, pas de reformulation qui change la portée, le chiffre ou le calendrier.

## Structure

```
index.html, assets/        site statique, sans build
data/candidates.json       candidats suivis (règle d'inclusion, sources de presse, statut du programme, domaines et documents officiels), personnes écartées
data/research/             recensement brut des candidats (sources de la règle d'inclusion)
data/measures/<id>.json    mesures d'un candidat
data/credibility.json      grille de l'indice (critères, poids, valeurs)
data/themes.json           vocabulaire utilisé par la recherche locale
data/verification.json     généré par scripts/verify_measures.py, ne pas éditer à la main
scripts/validate_data.py   contrôles bloquants (CI)
scripts/fetch_text.py      texte brut d'une page ou d'un PDF officiel, tel que le lit le robot : copier les extraits depuis cette sortie
scripts/check_measures.py  contrôle d'un seul fichier de mesures, sans rien écrire
scripts/verify_measures.py vérification quotidienne sur les sites officiels + archivage Wayback
worker/                    Cloudflare Worker du mode IA : détient la clé API (secret), relit les extraits, prompt fixe
```

## Ajouter un candidat (procédure)

1. Vérifier la candidature sur une source fiable et noter le site officiel de campagne ou du parti. Après le 12 mars 2027, se caler sur la liste officielle du Conseil constitutionnel.
2. Ajouter l'entrée dans `data/candidates.json` avec deux `declaration_sources` (médias nationaux distincts), `official_domains` (domaines nus) et, si besoin, `official_documents` (URL exactes de documents liés depuis le site officiel mais hébergés chez un prestataire). Renseigner `program_status` : `programme`, `propositions`, `aucun` ou `inaccessible` (site qui bloque les robots : ne jamais contourner).
3. Télécharger le programme depuis le site officiel (HTML ou PDF). Pour un PDF : `pdftotext -layout programme.pdf -` ou pdfplumber.
4. Créer `data/measures/<id>.json`. Copier chaque extrait depuis la sortie de `scripts/fetch_text.py` (jamais depuis un résumé). Plafond : 15 mesures par thème et par candidat, les plus précises. Une mesure = un engagement précis. Pour chacune : `id` stable (`<candidat>-<theme>-<nn>`), `theme` présent dans `themes.json`, `title`, `summary`, `excerpt` exact, `tags`, `source.url` et `source.locator` (page ou section).
5. Lancer `python scripts/validate_data.py` puis `python scripts/verify_measures.py --only <ids>`. Toute mesure qui n'est pas `verifie` doit être corrigée (extrait mal copié) avant commit.
6. Indice de solidité : renseigner seulement les critères pour lesquels une source existe (tableau de chiffrage publié par le candidat, chiffrage d'un institut indépendant, analyse juridique publiée). Noter la source dans `source_url` et un résumé factuel dans `note`.
7. Précision : `chiffree_et_datee` = objectif chiffré et échéance ; `chiffree` = chiffré sans échéance ; `intention` sinon (une date ou une durée seule reste une intention). `chiffrage_candidat` = `cout_et_financement` seulement si un financement est rattaché à la mesure elle-même, sinon `cout_seul`.

## Commandes utiles

```bash
python3 -m http.server 8000                       # site en local sur http://localhost:8000
pip install -r scripts/requirements.txt
python scripts/validate_data.py                   # contrôles bloquants
python scripts/verify_measures.py                 # vérification sur les sites officiels
python scripts/verify_measures.py --archive       # idem, avec archivage Wayback Machine
```

## Pistes d'amélioration, par priorité

1. Recherche sémantique locale (embeddings calculés au build, modèle multilingue exécuté dans le navigateur avec transformers.js) pour remplacer la correspondance par mots-clés.
2. Page de mentions légales et d'information RGPD complète, mention de transparence IA.
3. Vue par thème : toutes les mesures d'un thème, tous candidats, dans un ordre aléatoire.
4. Tests end-to-end Playwright dans la CI.
5. Audit d'accessibilité (RGAA).
