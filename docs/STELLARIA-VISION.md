# Stellaria OPEN PLC Editor — vision long terme

Document de cap. Complète `docs/STELLARIA-V3.md` (jalons du chantier) ;
les deux se lisent ensemble. État git : branche `stellaria/v3-only`,
2 commits locaux sur l'historique upstream 4.3.2 ; attention, `origin`
pointe encore vers `mickael-cala/openplc-editfork` (à réadresser quand
le dépôt dédié sera créé).

## 1. Architecture cible (où on va)

| Étape | Compilation du programme | Contrôle du PLC | Canal debug |
|---|---|---|---|
| **Aujourd'hui** (transitoire) | cible v3 via `plcbuild` (backend Go) | REST du backend Go (contrat mesuré, `docs/STELLARIA-V3.md` § Contrat) | Modbus TCP FC 0x41..0x45 |
| **Demain** | **locale dans l'IDE** : MatIEC (ST → C) + **Zig** (`zig cc` / `zig c++`) | toujours le backend Go, par transition | inchangé |
| **À terme** | locale, cross-compilée vers la cible (ex. Raspberry Pi arm-linux) | **PLC v3 headless** : plus de serveur Go, binaire poussé (ssh/scp), service systemd | inchangé |

## 2. Pourquoi Zig

- `zig cc` est un compilateur C complet (base clang) : il compile le C
  généré par **MatIEC** et les sources C/C++ du runtime v3.
- **Cross-compilation intégrée** : un seul outil shippe dans l'installateur,
  plus de toolchain gcc à installer côté utilisateur ; compilation vers le
  Pi (arm-linux) depuis Windows/Mac directement.
- Le runtime Pascal (`openplc-pascal-rewrite`) n'est **pas** concerné par
  cette chaîne : Zig sert à compiler le **programme IEC** (C issu de
  MatIEC) éventuellement lié au runtime C++ de référence v3, selon le
  scénario de déploiement retenu.

## 3. Ce que ça change dès maintenant

- L'éditeur ne doit **jamais dépendre du backend Go au-delà du contrat
  REST mesuré** — le serveur est un intermédiaire mort-né, pas une
  fondation. Toute fonctionnalité doit être justifiable dans l'architecture
  cible (section 1, colonne « À terme »).
- Le mode « simulateur » (= runtime local couche `blank`, voir
  `docs/STELLARIA-V3.md` § Simulateur) reste valide dans les trois étapes :
  c'est le même binaire runtime, juste piloté différemment.

## 4. Suivi de l'amont, en lecture seule

On **rebase planifié** sur les releases upstream pour récupérer :

- ✅ **améliorations générales de l'IDE** : éditeurs graphiques FBD/LD/SFC,
  Monaco, composants UI, i18n, performance, corrections de stabilité,
  gestion de projet, ergonomie ;
- ❌ **jamais les évolutions PLC** : STruC++ / pipeline C++, runtime v4
  (bundles Docker, WebSocket debug, snapshots), cartes Arduino + avr8js,
  VPP + catalogue/signatures, compte cloud / IA / télémétrie.

Méthode : à chaque release amont, relevé des commits « généralistes »
(titre/ne touche pas `src/backend/shared/compile`, `firmware`, `runtime`,
`vpp`, `simulator`), rebase de `stellaria/v3-only`, recette de contrat v3
rejouée (`docs/STELLARIA-V3.md` § J3).

**Décision du 2026-10-02 : la parité de surface avec openplc-web est abandonnée**
(`@micka`). Le miroir `compare-surfaces.py` / `ci-sync.yml` ne s'applique plus : le jeton
de synchro n'a jamais été configuré sur ce fork et le dépôt web n'est pas accessible
publiquement. Les arbres partagés sont les nôtres, ce qui rend J2 possible — sans cette
décision, tout retrait dans `src/backend/shared` était un miroir de plus.

Méthode, en **lecture seule** :

    git fetch upstream                  # https://github.com/Autonomy-Logic/openplc-editor (push désactivé)
    npm run upstream:triage             # 3 seaux : PLC (à ignorer), cloud/IA (à ignorer), généraliste (candidats)
    npm run upstream:triage -- --mark   # une fois la revue faite : déplace le marqueur .upstream-reviewed

Puis, au cas par cas, `git cherry-pick -x <sha>` (le `-x` garde le sha amont dans le
message) — **jamais de rebase** : nos retraits entreraient en conflit partout, et un
commit qui dépend d'un sous-système retiré se reprend comme **idée**, pas comme patch.
L'amont pousse sur `upstream/development` ; `upstream/main` ne bouge qu'aux releases
(`HEAD..upstream/main` est vide entre deux versions : surveiller `main` ne dirait rien).

## 5. Conséquences sur les jalons

- **J2** inchangé (retrait v4/Arduino/simulateur/VPP) — il prépare
  justement ce cap.
- **J5** : l'installateur embarquera un jour la chaîne MatIEC + Zig ;
  d'ici là, ne pas supprimer le chemin `plcbuild` (étape transitoire).
- **Nouveau jalon (à planifier)** : toolchain locale MatIEC + Zig dans
  l'IDE, coexistence avec le chemin `plcbuild` le temps de la bascule,
  puis retrait du backend Go quand le PLC headless est prêt côté runtime.
