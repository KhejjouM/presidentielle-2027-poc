# Ce qu'ils proposent pour vous

POC d'un outil citoyen pour la présidentielle 2027 : l'utilisateur décrit sa situation, l'outil affiche pour chaque candidat les mesures de son programme officiel qui s'y rapportent, avec :

- l'extrait exact du programme et le lien vers la source officielle ;
- un statut de vérification automatique (le texte figure-t-il toujours sur le site du candidat ou du parti ?) et une copie archivée ;
- un indice de solidité de la mesure, dont chaque critère et chaque poids sont visibles par l'utilisateur.

L'outil ne recommande aucun candidat. Les résultats sont classés par un score public et vérifiable (pour chaque mesure affichée, 3 au plus : pertinence pour la situation × indice de solidité ; égalités tirées au hasard). Chaque candidat a le même nombre maximal de mesures affichées, et les candidats sans mesure pertinente sont regroupés dans un encadré unique.

> **État actuel (13 novembre 2026) : candidats déclarés réels.** L'outil suit 34 personnes dont la candidature est rapportée par au moins deux médias nationaux, et intègre les mesures publiées sur leurs sites officiels (voir la section « Programmes intégrés » du site et `METHODOLOGIE.md`). La liste sera recalée sur la liste officielle du Conseil constitutionnel après le 12 mars 2027.

## Mettre en ligne sur GitHub Pages

1. Créer un dépôt GitHub et y pousser ce dossier :
   ```bash
   git init && git add . && git commit -m "POC initial"
   git branch -M main
   git remote add origin git@github.com:<vous>/<depot>.git
   git push -u origin main
   ```
2. Dans le dépôt : **Settings > Pages > Build and deployment > Source : Deploy from a branch**, branche `main`, dossier `/ (root)`.
3. Dans **Settings > Actions > General > Workflow permissions**, cocher **Read and write permissions** pour que le robot de vérification puisse publier `data/verification.json`.
4. Le site est disponible sous `https://<vous>.github.io/<depot>/` après une à deux minutes.

## Lancer en local

```bash
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

## Continuer avec Claude Code

Ouvrir le dossier avec Claude Code : le fichier `CLAUDE.md` lui donne les règles du projet (neutralité, sources officielles, extraits mot pour mot). Prompt de départ suggéré :

```
Lis CLAUDE.md. Pour les candidats suivants : <liste>, trouve le site officiel de campagne
ou du parti, récupère le programme publié et extrais les mesures selon la procédure.
Traite tous les candidats avec le même niveau de détail. N'ajoute aucune mesure dont tu
ne peux pas copier le texte exact. Lance validate_data.py et verify_measures.py, corrige
toute mesure non vérifiée, puis montre-moi un récapitulatif par candidat avant de committer.
```

## Les deux modes d'analyse

- **Recherche locale** (par défaut) : recherche par le sens (modèle multilingual-e5-small exécuté dans le navigateur avec transformers.js, environ 120 Mo téléchargés une fois) combinée aux mots-clés. Le texte saisi ne quitte pas l'appareil. Les vecteurs des mesures sont précalculés dans `data/embeddings.json` (`node scripts/embeddings/build_embeddings.mjs`).
- **Explication par IA** : après accord explicite de l'utilisateur, le texte saisi et les identifiants des mesures sélectionnées sont envoyés à un Cloudflare Worker (`worker/`) qui détient la clé API Anthropic. Le Worker relit lui-même les extraits officiels depuis le site publié, applique un prompt système fixe et renvoie une explication neutre par candidat. Les identifiants renvoyés sont filtrés : un candidat ou une mesure absent de la sélection est ignoré. Aucune journalisation.

- **Assistant pour préciser sa situation** : un court entretien (route `/clarify` du Worker) pose une ou deux questions à la fois, propose des réponses rapides et tient à jour un résumé de la situation, modifiable, qui sert ensuite à la recherche. Il a pour consigne de ne parler d'aucun candidat ni programme et de ne demander ni opinion politique ni donnée sensible. Consentement explicite requis, 20 échanges par minute et par IP au plus.

## Déployer le proxy IA (Cloudflare Worker)

La clé API ne doit jamais apparaître dans le dépôt ni dans le site : GitHub Pages est public. Elle vit uniquement comme secret du Worker.

```bash
cd worker
npm install
npx wrangler login                          # compte Cloudflare gratuit
npx wrangler secret put ANTHROPIC_API_KEY   # coller la clé sk-ant-...
npx wrangler deploy                         # affiche l'URL https://presidentielle-2027-ia.<compte>.workers.dev
```

Puis renseigner cette URL suivie de `/explain` dans `CONFIG.AI_PROXY_URL` (`assets/app.js`) et pousser. Tant que l'URL contient `REMPLACER`, le mode IA est masqué sur le site.

Protections en place : origines autorisées (`ALLOWED_ORIGINS` dans `wrangler.toml`), 5 requêtes par minute et par IP, texte limité à 1 200 caractères, 5 mesures par candidat, prompt et extraits fixés côté serveur. Fixer aussi une **limite de dépense mensuelle** dans la console Anthropic : c'est le seul plafond garanti.

Test local : `python3 -m http.server 8000` à la racine, `npx wrangler dev --var DATA_BASE_URL:http://localhost:8000/` dans `worker/` avec la clé dans `worker/.dev.vars` (ignoré par git), et `AI_PROXY_URL` pointé sur `http://localhost:8787/explain`.

## Points juridiques à faire valider avant un lancement public

Ces points ne constituent pas un avis juridique.

- **RGPD** : un texte décrivant une situation peut révéler des opinions politiques ou des données de santé (article 9). Le mode local ne collecte rien ; le mode IA repose sur un consentement explicite.
- **AI Act** : obligation d'informer l'utilisateur qu'il interagit avec une IA ; les systèmes destinés à influencer le vote sont classés à haut risque, avec des obligations applicables à partir du 2 décembre 2027 après le report adopté en 2026.
- **Droit électoral** : risque de diffusion de fausses informations si une mesure est mal attribuée (d'où l'extrait exact et la vérification quotidienne) ; pas de publication de statistiques d'usage du type « X % des utilisateurs », qui pourraient être assimilées à un sondage.

## Structure

Voir `CLAUDE.md` et `METHODOLOGIE.md`.
