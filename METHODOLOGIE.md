# Méthodologie

## Pourquoi un « indice de solidité » et pas une note de crédibilité

L'indice ne dit pas si une mesure est bonne, souhaitable ou juste. Il mesure à quel point elle est documentée et applicable, à partir de faits que chacun peut vérifier. Une mesure peut avoir un indice élevé et être jugée mauvaise par un électeur, et l'inverse.

## Les critères

| Critère | Poids | Ce qui est mesuré | Source exigée |
|---|---|---|---|
| Chiffrage par le candidat | 25 | Le candidat publie-t-il le coût et le financement ? | Oui, document du candidat |
| Chiffrage indépendant | 20 | Écart entre le chiffrage du candidat et une estimation indépendante | Oui, institut, Cour des comptes, etc. |
| Précision de l'engagement | 20 | Objectif chiffré et calendrier | Non, se lit dans l'extrait |
| Mise en œuvre juridique | 20 | Décret, loi, loi organique, révision constitutionnelle, conflit avec le droit de l'UE | Oui, analyse publiée |
| Présence sur le site officiel | 15 | Le texte exact figure-t-il toujours sur la source officielle ? | Contrôle automatique quotidien |

Les poids et les barèmes sont définis dans `data/credibility.json` et affichés sur le site.

## Règles de calcul

- Un critère sans élément sourcé n'est **pas noté** : il est exclu du calcul, ni pénalisant ni favorable. Le site affiche combien de critères sont renseignés.
- L'indice est la moyenne pondérée des critères renseignés, sur 100.
- En dessous de deux critères renseignés, aucun indice n'est affiché.
- La même grille s'applique à tous les candidats.

## Vérification automatique

Chaque jour, `scripts/verify_measures.py` télécharge la source de chaque mesure et cherche l'extrait :

- **vérifié** : texte identique après normalisation (espaces, accents, apostrophes) ;
- **approchant** : texte similaire mais modifié, par exemple un chiffre changé ; les chiffres absents de la source sont affichés ;
- **introuvable** : le texte n'est plus présent ;
- **source hors domaine officiel** : l'URL n'appartient pas aux domaines déclarés du candidat ;
- **erreur** : page inaccessible, le statut précédent est conservé en historique.

Les pages vérifiées sont archivées sur la Wayback Machine, ce qui conserve une preuve si le programme change.

## Limites connues

- La recherche locale repose sur des mots-clés : elle peut manquer une mesure formulée autrement.
- Le choix des critères et des poids est lui-même un parti pris méthodologique. Il est public pour pouvoir être discuté.
- Les estimations indépendantes ne couvrent pas toutes les mesures ni tous les candidats de la même manière ; c'est pourquoi un critère absent n'est pas pénalisant.
