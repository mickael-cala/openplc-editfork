# Stellaria OPEN PLC Editor — chantier « Runtime v3 only »

Ce dépôt part de l'éditeur OpenPLC v4 (fork de `mickael-cala/openplc-editfork`,
base upstream 4.3.2, branche `stellaria/v3-only`) et retire tout ce qui ne
sert pas la cible **OpenPLC Runtime v3**, plutôt que d'écrire un éditeur de
zéro. L'éditeur v4 sait déjà cibler la v3 — le chantier consiste à supprimer
les autres cibles et les services amont.

Principe directeur (risque « nettoyage qui casse ») : **retraits par étapes,
un seul chemin v3 joignable, tests à chaque étape.**

## Contrat v3 à respecter tel quel (mesuré, ne pas réinventer)

| Appel | Attendu |
|---|---|
| `GET /api/get-users-info` | 404 ou 200, ouvert, sans jeton |
| `POST /api/create-user` | 201 |
| `POST /api/login` | 200 + jeton |
| `POST /api/upload-file` | **200** (un 201 casse « Build & Upload ») |
| `GET /api/compilation-status` | 200 (`status`, `logs`, `exit_code`) affiché tel quel |
| `GET /api/start-plc` / `GET /api/stop-plc` | 200, corps `status` (`START:OK`, `ALREADY_RUNNING`, `STOP:OK`) |
| `GET /api/status` | 200, champ `status` (`RUNNING`/`STOPPED`) |
| Transport | HTTPS 8443, certificat auto-signé accepté ; le champ « Connect » est un **hôte**, pas une URL |
| En-tête | `X-OpenPLC-Runtime-Version: v3.0.0` (seul élément lu avant connexion) |

Debug Modbus TCP (FC 0x41..0x45) : canal issu de
`capabilities.debuggerTransports = ["modbus-tcp"]` ; le MD5 renvoyé par la
FC 0x45 se termine par la sentinelle native `0xDEAD` (2 octets à retirer) ;
le forçage par nom exige l'export `(*DBG:*)` (jalon J4), le forçage par
adresse fonctionne déjà.

## Ce qui existe DÉJÀ dans ce dépôt (à garder)

- `src/middleware/shared/utils/target-capabilities/presets.ts` —
  `RUNTIME_V3_CAPABILITIES` complet, dont `plcStateControl: true`
  (le run/stop REST v3 fonctionne déjà) et `debuggerTransports: ['modbus-tcp']`.
- `src/backend/shared/compile/__tests__/pipeline-runtime-v3.test.ts` —
  le pipeline de compilation a déjà un chemin v3 testé.
- `src/backend/shared/debug/modbus-pdu.ts` — le canal debug Modbus TCP.

## Jalons

### J1 — Fork + couper les services amont ✅ (ce commit)

- [x] `src/main/main.ts` : `electron-updater` retiré (classe `AppUpdater`
      supprimée, plus d'auto-update au lancement).
- [x] `src/main/modules/ipc/main.ts` : télémétrie AI coupée
      (`handleEdgeAiTelemetry` valide puis **drop** l'événement,
      `sendAiTelemetry` n'est plus appelé ni importé).
- [x] Catalogue public coupé : `handleCatalogList` répond « disabled (offline) »
      sans toucher le réseau ; `handleCatalogInstallMany` refuse ;
      `catalogTransport` / `listPublicLibraries` / `PublicLibrarySchema`
      retirés. Le module `public-catalog-client` existe toujours côté backend
      (les mocks de tests s'y réfèrent) mais plus rien ne l'appelle.
- [x] Test `edge-ai.handler.test.ts` aligné (le telemetry connu est accepté
      mais jamais transmis).

Reste J1 : audit réseau de la surface edge-* (compte, AI, cloud projects)
et retrait des dépendances devenues orphelines en J5.

### J2 — Une seule cible « OpenPLC Runtime v3 »

Emplacements identifiés à traiter, par étapes :

1. **Capabilities** — `target-capabilities/presets.ts` / `resolve.ts` :
   ne plus dériver `RUNTIME_V4_CAPABILITIES` ni `SIMULATOR_CAPABILITIES`
   ni `ARDUINO_CLI_CAPABILITIES` ; un board sans bloc explicite doit
   résoudre vers v3, pas vers v4 (aujourd'hui `inferFromCompiler` retourne
   v4 par défaut pour `openplc-compiler`).
2. **Boards** — `hals.json` (embarqué, identique desktop/web) : ne garder
   que l'entrée Runtime v3 ; vérifier `getAvailableBoards()`
   (`src/backend/editor/hardware`, ERR-062 : les `capabilities` ne doivent
   pas être perdues à la lecture).
3. **Packaging ZIP** — `src/backend/shared/compile/pipeline.ts` (étapes
   `runtime-v4-bundle`, `firmware-bundle`) et
   `src/middleware/shared/utils/library/compose-runtime-v4-bundle.ts` :
   court-circuiter pour ne produire que `program.st`.
4. **Binaires lourds** — `resources/bin/{win32,darwin,linux}` (~215 Mo :
   STruC++, arduino-cli) et `resources/sources/{Baremetal,arduino,...}` :
   retirer ; ajuster `scripts/download-binaries.ts` et le `postinstall`.
5. **Simulateur in-process** — `avr8js` (dep), `SimulatorModule`
   (`src/main/modules/ipc/main.ts`), `src/backend/shared/simulator/`.
6. **VPP** — `src/backend/editor/package-manager/`,
   `src/backend/shared/utils/vpp/`, l'écran Modbus VPP.

### J3 — Correctifs portés + recette de contrat

- Rejeu automatique du tableau « Contrat v3 » ci-dessus contre le backend
  et l'automate réels.
- Ne rien calculer côté empreinte : la cible renvoie le MD5 du `.st`
  (sentinelle comprise) — l'éditeur compare et retire les 2 octets.

### J4 — Debug complet

- Produire l'export `(*DBG:*)` dans le ST généré (la cible v3 le traite
  déjà) → débloque le forçage par nom. Le forçage par adresse reste tel quel.

### J5 — Packaging et identité

- Retraits de dépendances orphelines (`electron-updater`, `jszip` si le ZIP
  part, `avr8js`), `THIRD-PARTY.md`, mentions Autonomy Logic/marques,
  identité Stellaria (palette, crédits « Programmé par Mickaël CALA »).

## Hors périmètre

Pas de reprise du webserver (backend Go), pas de compilateur (c'est
`plcbuild` côté cible — l'éditeur n'envoie que le `.st`), pas d'écrans de
bus non repris (EtherCAT, OPC UA, S7 côté éditeur).
