# Stellaria OPEN PLC Editor — roadmap « Runtime v3 only » et recettes de test

> Document d'exécution. Il **complète** `docs/STELLARIA-V3.md` (jalons du chantier) et
> `docs/STELLARIA-VISION.md` (cap long terme) : ici, on trouve l'**état vérifié** du
> dépôt, la **roadmap détaillée** et les **recettes de test** contre le runtime Pascal
> (`openplc-pascal-rewrite`) et le backend Go (`openplc-go-backend`).
> Créé le 2026-10-02 par `@agent`, à la demande de `@micka`.

## 0. Sources et périmètre

| Source | Ce qu'elle fixe |
|---|---|
| `openplc-pascal-rewrite/docs/EDITOR.md` | mode d'emploi mesuré du couple éditeur v4.3.1 + runtime Pascal |
| `openplc-pascal-rewrite/docs/EDITOR-PATCHES.md` | défauts à corriger (P1..P5), état au 2026-10-02 |
| `openplc-pascal-rewrite/docs/EDITOR-V3.md` | brief du fork, jalons J1..J5, `ADR-022` |
| `openplc-pascal-rewrite/docs/RUNTIME-CONTRACT.md` | contrat externe (IPC, Modbus, artefacts, FC de debug) |
| `openplc-go-backend/ROADMAP.md`, `internal/api/handlers.go` | routes servies à l'éditeur (`WS-096`..`WS-098`) |

Ce document **ne modifie rien** dans les deux dépôts voisins : il cite leurs chemins et
leurs identifiants (`WS-`, `ERR-`, `ADR-`) pour que le travail à mener ici soit
traçable là-bas.

## 1. État vérifié de ce dépôt (branche `stellaria/v3-only`, base 4.3.2)

Méthode : lecture du code de ce dépôt et des deux dépôts voisins, sur le poste, le
2026-10-02. Chaque ligne est adossée à un chemin (et un numéro de ligne quand il
documente une décision).

### 1.1 Ce qui est déjà bon

| Élément | Preuve |
|---|---|
| La cible v3 existe dans le catalogue et déclare le bon canal de debug | `src/backend/shared/firmware/hals.json:65` — entrée `OpenPLC Runtime v3`, `capabilities.debuggerTransports: ["modbus-tcp"]`, canal `{ label: "Modbus TCP", channel: "tcp" }` |
| Le profil de capacités v3 existe, avec le pilotage REST | `src/middleware/shared/utils/target-capabilities/presets.ts` — `RUNTIME_V3_CAPABILITIES` (`debuggerTransports: ['modbus-tcp']`, `plcStateControl: true`) |
| Le chemin de compilation v3 est testé et n'emballe pas de ZIP | `src/backend/shared/compile/pipeline.ts:873` (étape 4b), `:906` (`Uploading program.st to Runtime v3...`), `__tests__/pipeline-runtime-v3.test.ts` |
| L'upload envoie un multipart `program.st` et n'accepte que **200** | `src/backend/editor/runtime/runtime-api-client.ts:673` (`/api/upload-file`), `:695` (`res.statusCode === 200`) |
| Le pilotage se fait en **GET** et lit `status` dans le corps | `src/backend/editor/runtime/runtime-api-client.ts:767-781` (`statusCommand`) |
| Le MD5 de la FC `0x45` est lu avec la sentinelle retirée | `src/backend/editor/modbus/modbus-client.ts:209` (`data.slice(9, data.length - 2)`), `src/backend/shared/debug/modbus-pdu.ts:233-275` |
| La disposition « Phase 4 » (3 octets `arr:u8 + elem:u16BE`) est implémentée | `src/backend/shared/debug/modbus-pdu.ts:13-42`, `:147-183` |
| Le CLI sans interface existe et couvre tout le flux | `docs/CLI.md`, `src/cli/debug/open-session.ts:105`, `src/cli/debug/variables.ts:63` |

### 1.2 Ce qui bloque (mesuré, non corrigé ici)

**D1 — le canal de debug v3 n'est jamais résolu (`ERR-062`) : toujours présent.**

`HardwareModule.getAvailableBoards()` reconstruit chaque entrée de `hals.json` et
**ne recopie pas `capabilities`** :

    src/backend/editor/hardware/hardware-module.ts:276
          ...(boardData.debug ? { debug: boardData.debug } : {}),
      // la ligne suivante du même littéral n'existe pas : `capabilities` est perdu

La résolution retombe donc sur `inferFromCompiler()` qui, pour
`compiler: 'openplc-compiler'`, rend `RUNTIME_V4_CAPABILITIES`
(`src/middleware/shared/utils/target-capabilities/resolve.ts:89-105`), soit
`debuggerTransports: ['websocket']`. Le canal `tcp` de la v3 n'est alors plus éligible
(`src/backend/shared/hardware/debug-spec.ts:121` `CHANNEL_TRANSPORT`, `:415`) et le
résolveur rend l'erreur `:429` *« This target declares no channel the editor can
connect through. »* — celle que `resolveRuntimeDebugChannel`
(`src/frontend/services/device-link-resolution.ts:285`) journalise avant d'abandonner.

Le chemin VPP, lui, recopie bien les capacités (`hardware-module.ts:376`) : seule la
lecture du **catalogue embarqué** est fautive. Aucun test ne couvre
`getAvailableBoards()` (les appelants sont mockés : `src/middleware/adapters/editor/__tests__/`).

Conséquence observée côté runtime (mesurée par `@micka`, `docs/EDITOR.md`) : connexion,
`Build & Upload` et `Play`/`Stop` fonctionnent, **le suivi de variables non**. Le
contournement actuel est le patch binaire `tools/editor-patch/patch-editor-capabilities.ps1`
(dépôt runtime), perdu à chaque mise à jour de l'éditeur.

**D2 — l'éditeur et la cible ne comptent pas les mêmes variables (mesuré le 2026-10-02).**

Les deux espaces d'index partent du **même** `program.st`, mais ne découpent pas les
variables de la même façon :

| Espace | Découpage | Preuve |
|---|---|---|
| Éditeur (`debug-map.json`, STruC++) | une **feuille par membre** : un tableau devient `ARR[0]`, `ARR[1]`, … | `docs/strucpp-migration/04-debugger.md` (feuilles « declaration order », exemple `speeds[0]`, `speeds[1]`) |
| Cible v3 (`core/debug.c`, `plcbuild`) | une **entrée par déclaration** : `ARR` d'un bloc, une instance de FB **absente** de la table | `tools/plcbuild/plcbuild.lpr` (`BuildDebugTable`) ; mesuré sur `pascal_test.st` : 8 entrées, **`TON1` n'y figure pas** |

**Programmes de scalaires seuls : les deux listes coïncident**, ordre compris — mesuré
deux fois avec `npm run debug:index` (éditeur 5 feuilles `DEMARRER, LED, CLIGNOTE,
SECONDES, TICKS` = cible 5 entrées dans le même ordre). L'ordre suit la déclaration du
`.st` **transpilé**, pas celui du POU source (le transpileur regroupe les blocs, et les
deux côtés suivent ce regroupement) — une comparaison « ordre source / table cible »
avait laissé croire à une rotation : c'était une erreur de méthode, corrigée ici.

Dès qu'un **tableau** ou une **instance de FB** apparaît, les comptes divergent
(mesuré, même `.st`) :

    éditeur : 5 feuilles   LED(0), ARR[0](1), ARR[1](2), ARR[2](3), N(4)
    cible   : 3 entrées    LED(0), ARR(1), N(2)         VAR_COUNT = 3

Conséquence : le contrôle de la FC `0x41` (comparaison du **compte**) échoue et la
session de debug est refusée — l'échec est **visible**, pas une corruption silencieuse.
Mais le suivi et le forçage **par nom sont inutilisables pour tout programme contenant
un tableau ou un FB**, ce qui est le cas courant. Un silence reste possible si les deux
comptes coïncident par accident (tableau d'un élément, feuilles de FB compensant
exactement un décalage) : c'est ce que J4.1 doit fermer.

**D3 — la note « plus rien à produire pour la cible » est incomplète.**

`WS-108` (dépôt runtime) a rendu la cible **autonome** : `plcbuild` génère la table de
debug sans blocs `(*DBG:*)`, et le forçage par nom fonctionne. Mais la note
« l'éditeur n'a donc **rien à produire** » (`docs/EDITOR-V3.md`, `J4`) ne dit pas comment
les deux espaces d'index restent d'accord — cf. D2. `plcbuild` **continue d'accepter**
une table fournie par le client (`tests/debug_format_check.cmd` : les lignes `(*DBG:*)`
sont extraites vers `core/debug.c` et le `md5` fourni est conservé), ce qui rouvre la
voie « l'éditeur fournit la table » si on la choisit (cf. D2, option A).

**D4 — points ouverts de `docs/EDITOR-PATCHES.md` (dépôt runtime).**

| Point | État | Chemin réel dans ce dépôt (la fiche cite `src/backend/shared/debug/modbus-client.ts`, qui n'existe pas) |
|---|---|---|
| `P2` — un forçage venu du backend n'est pas affiché comme forcé par l'IHM | ouvert, non bloquant | `src/frontend/utils/debug-polling-filter.ts:75` (`buildActiveIndexSet`), `hooks/useDebugPolling.ts:93`, `hooks/use-debug-value.ts:46-72`, `services/debug-force-variable.ts:46-67` |
| `P3` — FC `0x46`..`0x4b` non servies par la cible : jamais bloquantes | à confirmer dans le fork | le client les expose (`src/backend/editor/modbus/modbus-client.ts:27-43`) ; le runtime sert `0x4b` (`buildPlcSetStateRequest`) |
| `P4` — à la (re)connexion, relire l'état de la cible | à confirmer | `src/cli/debug/open-session.ts:155-176` (le CLI compare déjà le MD5 de la cible au `debug-map.json`) |
| `P5` — rappels de protocole | conformes | `modbus-client.ts:209` (sentinelle retirée), `modbus-pdu.ts:147-183` (Phase 4) |

**D4 — avec un FB *utilisateur*, la table de la cible est fausse et ne compile pas (mesuré le 2026-10-02).**

`plcbuild` extrait **toutes** les lignes `__DECLARE_VAR`/`__DECLARE_LOCATED` de `core/POUS.h`, puis
adresse chaque nom comme un champ de l'instance programme (`RES0__INSTANCE0.<NOM>`).
Or un FB défini **dans le projet** voit son `typedef` écrit dans le même `POUS.h` :

    // FUNCTION_BLOCK MYDELAYER   -> __DECLARE_VAR(BOOL,EN|ENO|IN|OUT|LAST)
    // PROGRAM MAIN               -> __DECLARE_LOCATED(BOOL,LED), MYDELAYER D1;, __DECLARE_VAR(INT,N)

Résultat mesuré (`st_files/d2_fb.st`) : `VAR_COUNT 7` (les 5 champs du FB **puis** LED et N) et
`get_var_addr` écrit `&RES0__INSTANCE0.EN.value` — un champ qui appartient à `MYDELAYER`, pas à
l'instance programme. `plcbuild` échoue alors à compiler le `debug.c` qu'il vient d'écrire
(`debug.c:68: error: field not found: LED`, `Compilation finished with errors!`).

Un FB **de bibliothèque** (`TON` de `pascal_test.st`) ne pose pas ce problème : son typedef vit dans
`iec_std_lib.h`, donc absent de `POUS.h`, donc absent de la table (mesuré : 8 entrées, `TON1` non listé).

Conséquence pour l'option B : la projection est **correcte sans FB utilisateur** (mesuré : scalaires
5/5, tableau 3/3 « identical order ») ; avec un FB utilisateur, aucune projection ne peut coïncider, et
la session échouera de toute façon sur le compte. À porter dans `ERRATA.md` du dépôt runtime
(`ERR-nnn`) : c'est un défaut de `plcbuild`, pas de l'éditeur.

### 1.3 État de J1 (livré) et de l'environnement

- J1 est livré sur cette branche : `dbd397cb9` (auto-update retiré, télémétrie IA droppée,
  catalogue public désactivé), `docs/STELLARIA-V3.md`.
- Au 2026-10-02, **Node.js 22.23.2 et `node_modules/strucpp` ont été installés** (voir
  § 4.0) : `tsc` et `jest` tournent, mais **il a fallu le runtime Visual C++ 2015-2022**
  pour que Jest démarre (détail et correctif en § 4.0 — le message d'erreur de Jest ne
  désigne pas la vraie cause).
- Présents et utilisables : `go 1.27.1`, FPC `C:\FPC\3.2.2\bin\i386-win32\fpc.exe`,
  TinyCC `C:\outils\tinycc32\win32\tcc.exe` et `tinycc64\win32\tcc.exe`, Git.
  **Python absent** : les contrôles `pymodbus_check.py` et `editor_frames_check.py`
  du dépôt runtime seront annoncés `SKIP` par leur harnais.
- Le runtime du poste est déjà compilé (`core/openplc.exe` 294 912 o, `core/plc.dll`,
  `active_program = program.st`), mais `core/` porte le programme **`editor_demo`**
  (5 variables) alors que `active_program` désigne `program.st` : un état de travail
  laissé par un essai précédent, à rejouer avant toute mesure (§ 4.5).

## 2. Roadmap

Ordre imposé par le risque : d'abord ce qui **empêche** de tester (D1), puis ce qui
**fausse** les mesures (D2), puis le reste.

### J2 — une seule cible « OpenPLC Runtime v3 »

| # | Tâche | Fichiers | Preuve d'acceptation |
|---|---|---|---|
| J2.1 | ~~Ne plus dériver v4/Arduino/simulateur dans le résolveur partagé~~ — **abandonné** : le défaut v4 vit dans la surface partagée, où il est **porteur côté web**, et depuis J2.2 aucune cible livrée n'emprunte ce chemin. Le risque résiduel (une entrée ajoutée sans bloc) est couvert par le test garde-fou de J2.2 | — | `jest …/available-boards-capabilities.test.ts` : 3 tests verts, dont « toute cible livrée déclare un bloc `capabilities` » |
| J2.2 | **Corriger D1** : recopier `capabilities` depuis `hals.json` — **FAIT** (`dc836980`, 2026-10-02) | `src/backend/editor/hardware/hardware-module.ts:276` (+ le champ `capabilities` au schéma d'entrée, `types.ts:63`) | **nouveau** test `src/backend/editor/hardware/__tests__/available-boards-capabilities.test.ts` : **2 tests verts avec**, **2 rouges sans** (mesuré, `git stash` de la seule ligne) |
| J2.3 | Réduire `hals.json` à la seule entrée v3 — **FAIT** (2026-10-02) : Simulator et Runtime v4 retirés (153 → 44 lignes, JSON revalidé) | `src/backend/shared/firmware/hals.json` | suite complète en 4 shards : les seules suites rouges (`arduino-cli-config`, `edge-project-upload`, `stats-table`, `cloud-project-data`, `cloud-build-workspace`, `debug-map-path.handler`) le sont **aussi sans ce changement** — vérifié en stashant (3 suites, 8 tests), ce sont des défauts de test **Windows** préexistants (séparateurs `/` en dur, timeout 5 s sur un test de 1000 fichiers). Aucune suite ne casse à cause du catalogue |
| J2.4 | Court-circuiter les bundles v4 : plus de `composeRuntimeV4Bundle` ni de `firmware-bundle` atteignables | `src/backend/shared/compile/pipeline.ts` (étapes 4a, 4c), `src/middleware/shared/utils/library/compose-runtime-v4-bundle.ts` | `pipeline-runtime-v3.test.ts` étendu : un projet v3 n'appelle **ni** `uploadRuntimeV4` **ni** `installArduinoCore` |
| J2.5 | Retirer le simulateur in-process (`avr8js`, `SimulatorModule`, `src/backend/shared/simulator/`) | `package.json:67`, `src/main/modules/ipc/main.ts`, `src/backend/shared/simulator/` | `npx tsc --noEmit` ; `npm run validate:arch` |
| J2.6 | Retirer VPP (catalogue local compris) et les écrans de bus non servis | `src/backend/editor/package-manager/`, `src/backend/shared/utils/vpp/`, écrans `ethercat`/`opcua`/`s7` | `npx eslint "./src/**/*.{ts,tsx}"` + `npx jest src/backend/editor` |
| J2.7 | Décider du sort de **STruC++** : il tourne encore pour la cible v3 (étape 3 du pipeline, avant 4b) **et** il est la source de `debug-map.json` | `src/backend/shared/compile/pipeline.ts:583-626`, `src/backend/shared/library/program-build-pipeline.ts` | décision tracée dans `docs/STELLARIA-VISION.md` § 5 ; tant qu'elle n'est pas prise, **ne pas** retirer le paquet : le retrait casse le côté éditeur de D2 |

> Attention à l'ordre : J2.2 doit passer **avant** J2.3. Sans capacités recopiées, retirer
> l'entrée v4 ne fait que changer le profil hérité, pas la cause.

### J3 — correctifs portés, contrat figé, recette rejouable

| # | Tâche | Fichiers | Preuve d'acceptation |
|---|---|---|---|
| J3.1 | Fixer le contrat v3 dans un **harnais automatisé** (verbatim de `docs/STELLARIA-V3.md` § Contrat) : `get-users-info` (404/200), `create-user` (201), `login` (200), `upload-file` (**200**, pas 201), `compilation-status`, `start-plc`/`stop-plc` (**GET**), `status` (`RUNNING`/`STOPPED`), en-tête `X-OpenPLC-Runtime-Version`, HTTPS 8443 cert auto-signé | nouveau `scripts/contract-v3.ts` (ou sous-commande `npm run cli -- contract`) réutilisant `RuntimeApiClient` | la commande sort en **0** contre le couple backend+runtime réels (§ 4.2) et en **non-zéro** si un code ou un verbe change (contre-épreuve : TLS coupé → échec de connexion) |
| J3.2 | Vérifier le chemin d'upload complet depuis l'éditeur, cible v3 | `src/backend/editor/compiler/editor-compiler-platform-port.ts:529` | `npm run cli -- upload <projet> --target "OpenPLC Runtime v3" --host 127.0.0.1 --credentials openplc:openplc --yes` → `uploaded: true`, puis `core/debug.c` régénéré côté runtime |
| J3.3 | Porter `P4` (relire l'état de la cible à la reconnexion) et confirmer `P3` (aucune FC `0x46`+ requise) | `src/cli/debug/open-session.ts`, `src/frontend/hooks/useDebugSession.ts` | `debug open` sur un PLC redémarré ne sert pas de cache : le MD5 cible est relu (`open-session.ts:155`) |
| J3.4 | Mettre à jour `docs/EDITOR-PATCHES.md` (dépôt runtime) : chemin réel du client de debug, état de D2 | hors dépôt | la fiche ne cite plus `src/backend/shared/debug/modbus-client.ts` (inexistant) |

### J4 — debug vérifié de bout en bout (le cœur du risque)

| # | Tâche | Fichiers | Preuve d'acceptation |
|---|---|---|---|
| J4.0 | **Mesurer D2** — **FAIT** (2026-10-02, `npm run debug:index`) : scalaires = listes identiques, composites = comptes divergents (5 vs 3 sur un tableau, `TON1` absent de la table cible) | `scripts/debug-index-order.ts` | sortie de la sonde sur `program-transpiled.st` (5/5 identiques) et `program-array.st` (5 vs 3) ; les deux côtés construits depuis le **même** `.st` |
| J4.1 | Trancher D2 — **TRANCHÉE le 2026-10-02** (`@micka`) : **(B) tout de suite** (l'éditeur replie ses feuilles à la granularité « déclaration », comptes alignés, composites opaques) **avec (C) comme cible** (la cible publie sa table `index → nom/type/taille` ; ADR côté runtime à écrire). **(A) écartée** : travail runtime le plus lourd, et il faudrait y rejouer les dispositions de FB des bibliothèques | (B) : `src/frontend/utils/debug-v3-projection.ts` + `useDebugSession.ts:96` ; (C) : `docs/DECISIONS.md` du dépôt runtime | (B) cœur **fait** : `projectV3DebugEntries` + 11 tests, dont les deux cas mesurés (scalaires 5/5, tableau → LED/ARR/N renumérotés) ; restent le calcul des instances de FB et le branchement |
| J4.2 | Corriger `P2` (afficher un forçage venu d'ailleurs) selon l'option retenue | `src/frontend/utils/debug-polling-filter.ts:75`, `hooks/use-debug-value.ts`, `services/debug-force-variable.ts`, `_atoms/graphical-editor/debug-value-badge.tsx` | recette § 4.5 étapes 4-6 : la variable apparaît « forcée » **sans action** de l'utilisateur ; relâcher remet l'affichage d'aplomb |
| J4.3 | Garder le forçage **par adresse** (`%QX/%QW/%MW/%MD/%ML`, entrées en lecture seule) tel quel | `src/backend/editor/modbus/modbus-client.ts:322` (`setVariable`) | § 4.5 étape 7 : écrire `%QX0.0` par adresse, relire par Modbus (FC1) |

### J5 — packaging, identité, diète d'installation

| # | Tâche | Fichiers | Preuve d'acceptation |
|---|---|---|---|
| J5.1 | Retirer les binaires qui ne servent plus : `resources/bin` = **212,2 Mo**, `resources/sources` = **6,9 Mo** | `resources/`, `scripts/download-binaries.ts`, `package.json` (`postinstall`, `setup:strucpp`) | `npm run build` puis lancement : la cible v3 est toujours proposée, `resources/bin` ne contient plus que ce qui est consommé |
| J5.2 | Retirer les dépendances orphelines | `package.json` : `electron-updater` (:77), `avr8js` (:67), `jszip` (:83) selon J2 | `npx tsc --noEmit`, `npx eslint "./src/**/*.{ts,tsx}"`, `npm run package` |
| J5.3 | Identité et licence : retirer Autonomy Logic / marques tierces, `THIRD-PARTY.md`, crédits | `docs/STELLARIA-BRANDING.md` du dépôt runtime (`ADR-023`), `release/app/package.json` (`license: MIT` à corriger : l'amont est GPL-3.0) | relecture de l'installeur + `THIRD-PARTY.md` présent |

### J6 — (cap) chaîne locale MatIEC + Zig

Inchangé par rapport à `docs/STELLARIA-VISION.md` § 5, mais **dépend de D2** : c'est la
compilation locale qui redonne à l'éditeur la connaissance des symboles générés, donc
l'option (A) de J4.1.

### Ordre recommandé (le plus court chemin vers une recette rejouable)

    1. J2.2 (D1) + son test   → le canal de debug v3 se résout
    2. J4.0 (D2) mesure       → on sait si les index coïncident
    3. J4.1 (D2) décision     → conditionne J4.2 et J2.7
    4. J3.1 (contrat) + J3.2  → la recette de contrat devient automatique
    5. J2.1, J2.3..J2.6, J2.7 → retraits, chacun adossé à un test
    6. J4.2 (P2), puis J5

## 3. Ce qu'il ne faut pas faire

- **Ne pas retirer STruC++ avant J4.1** : il fournit `debug-map.json`, donc l'espace
  d'adressage de debug de l'éditeur.
- **Ne pas se fier au compte de variables (`0x41`) comme contrôle d'alignement** : D2
  montre un espace identique en nombre et décalé en ordre.
- **Ne pas rejouer `setup:strucpp` en croyant tester un correctif local de STruC++** :
  la commande écrase `node_modules/strucpp` (voir `CLAUDE.md`).
- **Ne pas conclure « OK » sur un forçage qui change bien une valeur affichée** : vérifier
  que c'est la **même** variable côté cible (`core/debug.c`), côté tampon (`%QX`) et
  côté plan Modbus (FC1/FC3).

## 4. Recettes de test

### 4.0 Pré-requis machine (constat du 2026-10-02)

| Outil | État | Conséquence |
|---|---|---|
| Node.js ≥ 22 < 24 / npm | **installé le 2026-10-02** (`winget install --id OpenJS.NodeJS.22`) | ouvrir un nouveau terminal après l'installation (`node -v` → `v22.23.2`) |
| `node_modules/strucpp` | **installé** | `npm ci --ignore-scripts && npm run setup:strucpp` (réseau requis : release GitHub) — sans quoi `tsc` et `jest` échouent sur `TS2307: Cannot find module 'strucpp'` |
| **Runtime Visual C++ 2015-2022 (x64)** | **absent du poste** → `jest` ne démarrait pas | Jest 30 résout les modules via `unrs-resolver`, un addon natif qui importe `VCRUNTIME140.dll` ; sans ce runtime Windows refuse de le charger (« Le module spécifié est introuvable »), le résolveur ne résout plus rien et Jest échoue sur `setupFiles … was not found` — un message qui ne dit rien de la vraie cause. **Correctif durable** : `winget install --id Microsoft.VCRedist.2015+.x64 -e` (élévation admin). Dépannage immédiat sans admin : copier `vcruntime140.dll` (+ `vcruntime140_1.dll`, présents dans le WinSxS de WebView2) **à côté de** `node_modules/@unrs/resolver-binding-win32-x64-msvc/resolver.win32-x64-msvc.node` — mais `npm ci` efface cette copie |
| Go 1.27.1 | présent | `go build ./...` dans `openplc-go-backend` |
| FPC 3.2.2 + TinyCC 32/64 | présents | reconstruction du runtime possible (`scripts\build-runtime.cmd all`) |
| Python | **absent** | `pymodbus_check.py` (12 vérifications) et `editor_frames_check.py` (19 trames) seront `SKIP` |

- Les trois dépôts doivent être **côte à côte** : `C:\Users\micka\gh\{oplc-editor-ngv3,
  openplc-pascal-rewrite, openplc-go-backend}` (les chemins de `tests/go_backend_config.json`
  et de `-workdir` pointent en dur).
- Ports utilisés : **8443** (HTTPS de l'éditeur, imposé), **8080** (interface/API HTTP),
  **502** (Modbus TCP de l'automate), **43628** (IPC du runtime), 18080 (recette backend).
  Un port occupé se traduit par un échec « bind » silencieux : à vérifier avant chaque recette.

### 4.1 Chaîne runtime seule (dépôt `openplc-pascal-rewrite`)

    scripts\build-runtime.cmd all                     :: win32 + win64 (nettoyage inclus)
    tools\plcbuild\plcbuild.exe --st=pascal_test.st --root=. --verbose
    core\openplc.exe --work-dir=. --driver=blank --ticks=20

    tests\run_tests.cmd all                           :: recette complète (unitaires + bout en bout)
    tests\run_unit_tests.cmd                          :: sans iec2c (étapes sautées annoncées)
    tests\debug_format_check.cmd                      :: export éditeur (*DBG:*) + md5 + gcc strict
    tests\plcbuild_cli_check.cmd                      :: contrat CLI de plcbuild

Attendu (valeurs de référence du dépôt) : `Compilation finished successfully!`, puis
`###Summary: The maximum/minimum/average cycle time`, `tick 50000000 ns`.
Après un `plcbuild`, vérifier **à la main** la table réellement produite :

    Select-String -Path core\POUS.h  -Pattern '__DECLARE'              :: ordre des champs (celui de la cible)
    Select-String -Path core\debug.c -Pattern 'case [0-9]: return'     :: index -> symbole

### 4.2 Backend Go + runtime (le « simulateur » de fait, `ADR-002`)

    cd C:\Users\micka\gh\openplc-go-backend
    go build ./... ; go test ./... -count=1
    go build -o openplc-backend.exe ./cmd/server

    .\openplc-backend.exe -workdir C:\Users\micka\gh\openplc-pascal-rewrite `
        -http 127.0.0.1:8080 -tls-addr 127.0.0.1:8443 -runtime core/openplc.exe

Le certificat auto-signé est généré au besoin dans `<workdir>\build\cert.pem|key.pem`
(`internal/tlsutil`, `WS-053`) — les fichiers sont déjà présents sur ce poste.

Contrat, à rejouer tel quel (`curl -k`, comme l'éditeur qui accepte un certificat
auto-signé — `getRuntimeHttpsOptions` : `rejectUnauthorized` faux par défaut) :

    curl -k -i https://localhost:8443/api/get-users-info       :: 404 (aucun compte) ou 200 ; en-tete X-OpenPLC-Runtime-Version: v3.0.0
    curl -k -X POST -H "Content-Type: application/json" `
         -d '{"username":"openplc","password":"openplc"}' https://localhost:8443/api/login
    :: -> access_token (JWT) ; le porter ensuite en Authorization: Bearer

    curl -k -H "Authorization: Bearer $T" https://localhost:8443/api/status
    curl -k -X POST -H "Authorization: Bearer $T" `
         -F "file=@..\openplc-pascal-rewrite\st_files\editor_demo.st" `
         https://localhost:8443/api/upload-file                 :: 200 {"CompilationStatus":"COMPILING"} (un 201 casse « Build & Upload »)
    curl -k -H "Authorization: Bearer $T" https://localhost:8443/api/compilation-status
    curl -k -H "Authorization: Bearer $T" https://localhost:8443/api/start-plc   :: GET, corps {"status":"START:OK"}
    curl -k -H "Authorization: Bearer $T" https://localhost:8443/api/stop-plc
    curl -k -H "Authorization: Bearer $T" 'https://localhost:8443/api/read?addr=%25QX0.0'
    curl -k -X POST -H "Authorization: Bearer $T" -H "Content-Type: application/json" `
         -d '{"index":1,"type":"BOOL","value":"1","force":true}' https://localhost:8443/api/force
    curl -k -H "Authorization: Bearer $T" https://localhost:8443/api/debug         :: {"count":N,"md5":"..."} : compte et empreinte de la cible
    curl -k -H "Authorization: Bearer $T" 'https://localhost:8443/api/debug?index=0'  :: valeur de l'index 0, à comparer à core/debug.c

Recettes d'intégration déjà écrites (dépôt runtime) :

    tests\go_backend_smoke.cmd        :: 17 assertions runtime <-> backend (jeton obligatoire)
    tests\test-tout.cmd               :: build + programme IEC + backend + intégration
    tests\editor_frames_check.py      :: SKIP sans Python (trames exactes du client de l'éditeur)

### 4.3 Éditeur — interface graphique

    cd C:\Users\micka\gh\oplc-editor-ngv3
    npm ci --ignore-scripts
    npm run setup:strucpp            # requis avant tsc/jest, et avant tout build
    npm run build                    # main + renderer
    npm run dev                      # port 1313, Electron

Dans l'éditeur : **Device** → cible `OpenPLC Runtime v3` → champ `Connect` = **hôte**
(`localhost`, ni URL ni port : l'éditeur impose 8443) → compte `openplc`/`openplc`
→ **Build & Upload** → **Play** → panneau Debug.

Contrôles attendus, dans la **console de l'éditeur** :

- avant J2.2 : `[connection] OpenPLC Runtime v3: could NOT describe a debug channel —
  resolver returned "error": This target declares no channel the editor can connect
  through.` puis `debugging will not be available` (mesure `ERR-062`) ;
- après J2.2 : `[link] debug session: using the debug channel`, et côté runtime
  `Debug: FC41 variable count = N`.

Vérifications complémentaires : `GET /api/compilation-status` affiché tel quel dans la
console ; **Search** ne trouve rien (la découverte n'est pas servie : 404 sur
`/api/discovery/interfaces` et `/api/serial-ports`) — utiliser `Connect`.

### 4.4 Éditeur — CLI sans interface (le chemin automatisable)

    npm run build                    # le CLI s'exécute depuis release/app/dist/main/main.js
    npm run cli -- --version
    npm run cli -- packages list                              :: cible « OpenPLC Runtime v3 »
    npm run cli -- devices
    npm run cli -- compile <projet> --target "OpenPLC Runtime v3"
    npm run cli -- upload  <projet> --target "OpenPLC Runtime v3" --host 127.0.0.1 --yes
    npm run cli -- debug open <projet> --target "OpenPLC Runtime v3" --host 127.0.0.1
    npm run cli -- debug list-vars
    npm run cli -- debug read main:counter
    npm run cli -- debug force main:led TRUE
    npm run cli -- debug close --all

`stdout` = **un seul** document JSON, la progression va sur `stderr` ; les codes de
sortie sont stables (0 ok, 3 introuvable, 4 échec de compilation, 5 connexion, 6
authentification, 7 refus de la cible, 8 délai — `docs/CLI.md`). `--credentials` ou
`OPENPLC_CREDENTIALS=openplc:openplc`. `debug open --upload-if-needed` compile et envoie
si l'empreinte diffère ; `debug close` **relâche les forçages** (sauf `--keep-forces`).

Comme le CLI partage `resolveRuntimeDebugChannel` (`src/cli/debug/open-session.ts:105`),
il est **bloqué par D1 exactement comme l'interface** : c'est le meilleur endroit pour
écrire la non-régression de J2.2 (échec avant, succès après).

### 4.5 Recette croisée éditeur ↔ cible, et mesure de D2

À rejouer après J2.2, sur le **même** fichier `.st` (fixture conseillée :
`st_files/editor_demo.st`, puis `pascal_test.st` car il contient une instance de FB) :

1. compiler et envoyer depuis l'éditeur (`upload`) puis `debug open --upload-if-needed` ;
2. consigner `<projet>/build/OpenPLC Runtime v3/src/debug-map.json` → **feuilles dans
   l'ordre**, et `core/POUS.h` / `core/debug.c` côté runtime → **champs dans l'ordre** ;
3. comparer les deux listes **rang par rang** (nom, type, taille). Une égalité de compte
   seulement ne conclut rien : c'est le piège de D2 ;
4. forcer une variable **depuis l'éditeur** et vérifier les **trois** plans : la valeur
   relue par le canal de debug, le tampon (`/api/read?addr=%25QX…`) et le plan Modbus
   (FC1/FC3) ;
5. forcer la même variable **depuis le backend** (`POST /api/force`) et vérifier qu'elle
   apparaît comme forcée dans l'éditeur **sans action de l'utilisateur** (`P2`) ;
6. relâcher (`"force":false`) : l'affichage redevient ordinaire ;
7. forcer **par adresse** (`%QX0.0`) : indépendant de la table de debug, ce chemin doit
   rester fonctionnel même si D2 est ouverte.

### 4.6 Vérifications de code côté éditeur (avant tout envoi)

    npx tsc --noEmit
    npx prettier --check "./src/**/*.{ts,tsx}"
    npx eslint "./src/**/*.{ts,tsx}"
    npx jest --config jest.config.json --collectCoverage --ci
    npm run validate:arch

`npm run lint` / `npm run format` **corrigent** : elles passent localement là où la CI
(`--check`) échoue — utiliser les commandes ci-dessus pour une vérification fidèle.

Playwright (aucun workflow CI ne le lance ici) :

    npm run build
    mkdir -p release/app/configs/dll
    cp release/app/dist/main/preload.js release/app/configs/dll/preload.js
    npx playwright test e2e/<spec>.ts --workers=1

### 4.7 Pièges connus (déjà payés une fois)

- **Le préload doit être copié** dans `release/app/configs/dll/` sinon la fenêtre est
  blanche ; ne **pas** définir `NODE_ENV=development` ; `firstWindow()` rend le splash.
- Modifier un `.st` pendant que le PLC tourne ne suffit pas : `plcbuild` recompile le
  blob **et** la cible refuse une compilation à chaud si le PLC est `RUNNING` — utiliser
  `--yes` (CLI) ou arrêter le PLC d'abord.
- Sous Windows, arrêter le runtime **avant** toute recompilation (binaire verrouillé).
- Les protocoles ne sont activés qu'après un `start` réussi : sans `start`, il n'y a
  **pas** de serveur Modbus, donc pas de canal de debug.
- La table de debug vit dans `core/debug.c` : **ne jamais l'éditer à la main** (elle est
  produite à chaque `plcbuild`).
- `setup:strucpp` écrase `node_modules/strucpp` : rejouer la suite **après**, jamais en
  s'appuyant sur un run antérieur.

## 5. Décisions à prendre (propriétaire : `@micka`)

| # | Décision | Impact | Défaut proposé |
|---|---|---|---|
| D-0 | **Parité de surface avec openplc-web** | **tranchée le 2026-10-02 : rupture** (`@micka`) — sans elle, tout retrait dans `src/backend/shared` (à commencer par `hals.json`) était un miroir de plus, et `Autonomy-Logic/openplc-web` n'est même pas accessible publiquement. L'amont `Autonomy-Logic/openplc-editor` reste suivi **en lecture seule** (`npm run upstream:triage`, `docs/STELLARIA-VISION.md` § 4) | — |
| D-a | Espace d'index de debug v3 — **tranchée le 2026-10-02** : (B) maintenant, (C) comme cible ; (A) écartée. Preuve de la décision : `docs/STELLARIA-V3-ROADMAP.md` § D2 (mesures J4.0) | fiabilité du forçage par nom ; périmètre runtime (C) | — |
| D-b | Sort de STruC++ pour la cible v3 | poids d'installation, source de `debug-map.json`, prérequis de J6 | **conserver tant que D-a n'est pas tranchée** |
| D-c | VPP : retrait complet ou conservation d'un format de paquet local | J2.6, écrans Modbus VPP | retrait, une seule cible décrite dans `hals.json` |

## 6. Journal de vérification de ce document

- Établi par lecture seule des trois dépôts ; **aucun fichier des deux dépôts voisins
  n'a été modifié**.
- Mesures faites sur le poste : `core/POUS.h`, `core/debug.c`, `core/openplc.exe`
  (294 912 o), `build/win32`, `resources/bin` (212,2 Mo), présence de FPC/TinyCC/Go,
  absence de Node/npm/Python et de `node_modules/strucpp`.
- **Rejoué le 2026-10-02 après installation de Node 22.23.2** (commandes exécutées avec le
  binaire absolu, `npx` n'étant pas encore dans le `PATH` du shell appelant) :

  | Commande | Résultat |
  |---|---|
  | `jest src/backend/editor/hardware` (avant correctif) | 8 suites / 110 tests, **0 échec** (baseline) |
  | `jest …/available-boards-capabilities.test.ts` **avec** J2.2 | **2/2 verts** |
  | idem **sans** la ligne J2.2 (`git stash`) | **2/2 rouges** — le test garde bien le correctif |
  | `tsc --noEmit` | exit 0 |
  | `prettier --check` (3 fichiers touchés) | conforme |
  | `eslint` (2 fichiers `src`) | 0 erreur ; 1 avertissement **préexistant** (`debug: z.any()`, `hardware-module.ts:276`) |
  | `jest src/backend/editor/hardware src/backend/shared/hardware src/backend/shared/firmware src/middleware/shared/utils/target-capabilities src/frontend/services/__tests__/device-link-resolution.test.ts` | 16/17 suites ; **`board-info-resolver.test.ts` échoue (4 tests) — préexistant** (attentes de séparateurs de chemin Windows, reproduit sans les changements) |
  | `jest src/middleware/adapters/editor src/backend/shared/compile` | **39 suites / 918 tests, 0 échec** |

- **Reste non vérifié** : `npm run build`, `npm run dev`, la recette Playwright, et la mesure
  end-to-end de D2 (§ 4.5). Les deux sources de D2 sont néanmoins citées
  (`04-debugger.md:136` pour l'éditeur, `plcbuild.lpr:735` + `core/debug.c:61-65` pour la
  cible) : la divergence est **établie par lecture**, à confirmer par la recette.
- Références dépôt runtime : `ERR-061` (flux éditeur vérifié), `ERR-062` (capacités),
  `ERR-063`/`WS-108` (table de debug de la cible), `ERR-064` (sentinelle), `ERR-066`
  (Phase 4), `ERR-067` (ordre/tampon), `WS-096`..`WS-098` (routes servies).


- **J2.3 (2026-10-02)** — `hals.json` réduit à `OpenPLC Runtime v3` ; suite complète rejouée en 4 shards
  (`jest --shard=n/4 --maxWorkers=3`, la machine n'a que 4 cœurs et un run complet dépasse 10 min) :
  ~508 suites, ~10 400 tests, **6 suites rouges dont les 12 tests échouent à l'identique sur l'arbre propre**
  (vérifié par `git stash` sur 6 suites) — ce sont des défauts de test Windows, sans rapport avec le catalogue :

  | Suite rouge | Cause |
  |---|---|
  | `backend/editor/services/user-service/data/__tests__/arduino-cli-config.test.ts` | attentes `/home/user/.config/...` contre `\home\user\.config\...` |
  | `frontend/components/_molecules/stats-table/__tests__/stats-table.test.tsx` | 2 tests, instable ici (passe dans un run, échoue dans un autre) |
  | `backend/editor/project/__tests__/cloud-project-data.test.ts` | `startsWith(root + '/')` en dur, Windows renvoie `\` |
  | `backend/editor/project/__tests__/cloud-build-workspace.test.ts` | idem |
  | `main/modules/ipc/__tests__/debug-map-path.handler.test.ts` | 1 test, même famille (chemin) |
  | `backend/editor/edge-project-upload/__tests__/edge-project-upload.test.ts` | timeout 5 s : le test crée 1000 fichiers, trop lent sous Windows |

  Conséquence : « suite verte » n'est pas atteignable telle quelle sur ce poste ; ce sont les 6 suites à réparer
  (petit lot séparé, hors périmètre J2) avant de se servir de la suite locale comme porte.

- **J4.0 (2026-10-02)** — sonde `npm run debug:index` (scripts/debug-index-order.ts) : les deux
  espaces sont bâtis depuis le **même** `program.st`, l'un par STruC++ (pipeline de l'éditeur,
  appelé directement par la sonde), l'autre par `plcbuild` (`core/POUS.h`). Résultats :
  scalaires → 5 feuilles / 5 entrées **de même ordre** ; tableau + scalaire → **5 vs 3**
  (`ARR[0..2]` contre `ARR`) ; `pascal_test.st` → la cible ne liste pas `TON1` du tout.
  Au passage : pour la cible v3, le pipeline n'écrit **rien** sur disque (`<projet>/build/
  <cible>/src/` reste vide), donc `openplc-cli debug open` n'a pas de `debug-map.json` à lire
  — le chemin debug du CLI est inutilisable en v3 aujourd'hui (à traiter en J3).

- **Nettoyage du poste (2026-10-02)** : le PLC (pid 17800) et le backend Go (pid 15672), laissés en
  marche par la session précédente, ont été arrêtés **dans l'ordre documenté** — `POST /api/stop`
  (`{"status":"stopped"}`), puis arrêt du backend ; ports 502, 43628, 8080 et 8443 libérés, aucun
  `openplc`/`electron` résiduel. `core/` a été recompilé proprement sur `st_files/pascal_test.st`
  (`Compilation finished successfully!`, `VAR_COUNT 8`) — le verrou sur `plc.dll` venait du runtime
  en marche, pas d'un défaut.
- **Option B, incrément 1 (2026-10-02)** : `src/frontend/utils/debug-v3-projection.ts` —
  `declarationPathOf` (feuille → déclaration) et `projectV3DebugEntries` (une entrée par déclaration,
  **index = ordinal**, instances de FB écartées). 11 tests, adossés aux listes réellement écrites par
  `plcbuild`. Restent : le calcul des instances de FB depuis le projet, le branchement dans
  `useDebugSession.ts:96` (et `src/cli/debug/variables.ts:133`), et la persistance des artefacts v3
  (`<projet>/build/<cible>/src/`) sans laquelle le chemin debug du CLI reste sans `debug-map.json`.

- **Option B, incréments 2 et 3 (2026-10-02)** — `functionBlockInstancePaths` (réutilise
  `isFunctionBlockType`, la règle de l'arbre, donc un STRUCT reste en place), branchement dans
  `useDebugSession.ts` (conditionné à `debuggerTransports: ['modbus-tcp']`, avec un log explicite
  « N leaves projected onto M target entries »), et sonde étendue (`--fb`). Vérification appariée,
  même `.st` des deux côtés : **scalaires 5/5**, **tableau 5 feuilles → 3 entrées = 3 de la cible**,
  verdict « identical order » dans les deux cas ; **FB utilisateur** → D4 (défaut `plcbuild`).
  Reste J3 : persister `program.st` + `debug-map.json` sous `<projet>/build/<cible>/src/` pour que
  le CLI (et `src/cli/debug/variables.ts`) voie la même table que la GUI.

- **J3-a (2026-10-02)** — les entrees de build v3 sont desormais ecrites sous
  `<projet>/build/<cible>/src/` : `CompilerPlatformPort.persistRuntimeV3Sources` (optionnelle) est
  appelee par la branche v3 **avant** le retour compile-only (`openplc-cli compile` est exactement ce
  cas), et l'adaptateur editeur y ecrit `program.st` + `debug-map.json` (un echec n'echoue pas le
  build : ces deux fichiers sont ce que le debugger relit). Verifie de bout en bout avec le CLI dev :
  « Build inputs written to ...\build\OpenPLC Runtime v3\src », 5 feuilles, md5 93f2074a...
  Au passage, la carte reelle enterine la correction de D2 : le `program.st` transpile declare
  `ticks` **en premier** et la carte est `TICKS, DEMARRER, LED, CLIGNOTE, SECONDES` — soit l'ordre
  exact de `core/POUS.h` cote cible. Les deux espaces coincident des lors qu'ils partent du meme
  source **transpile** ; l'« ecart d'ordre » initial venait bien de la methode de comparaison.