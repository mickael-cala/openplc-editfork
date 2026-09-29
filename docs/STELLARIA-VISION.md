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

## 4. Politique de suivi de l'amont v4

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
rejeuée (`docs/STELLARIA-V3.md` § J3).

## 5. Conséquences sur les jalons

- **J2** inchangé (retrait v4/Arduino/simulateur/VPP) — il prépare
  justement ce cap.
- **J5** : l'installateur embarquera un jour la chaîne MatIEC + Zig ;
  d'ici là, ne pas supprimer le chemin `plcbuild` (étape transitoire).
- **Nouveau jalon (à planifier)** : toolchain locale MatIEC + Zig dans
  l'IDE, coexistence avec le chemin `plcbuild` le temps de la bascule,
  puis retrait du backend Go quand le PLC headless est prêt côté runtime.
