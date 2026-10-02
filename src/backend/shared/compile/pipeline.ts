/**
 * Shared OpenPLC compile pipeline.
 *
 * Single source of truth for the full compile flow (Steps 0–13 in
 * the editor's canonical pipeline).  Editor and web both drive this
 * function through a `CompilerPlatformPort`; the platform port
 * abstracts the three places where platform truly differs (ST transpiler
 * transport, arduino-cli transport, runtime upload transport).
 * Everything else — preprocessing, XML generation, strucpp compile,
 * conf authoring, defines authoring, bundle composition, ordering,
 * error formatting, log messages — is shared.
 *
 * Editor-canonical behaviour: every byte and every log line matches
 * what editor's `handleCompile` used to emit before this refactor.
 * The web pipeline will produce identical output once it lands on
 * this function in a follow-up PR.
 *
 * The function is pure with respect to side effects EXCEPT for the
 * platform port calls (subprocess spawns / HTTP requests) and the
 * `emit` callback (progress events).  No disk I/O, no globals.
 */

import type {
  CompilerPlatformPort,
  PlatformDeviceContext,
  PlatformLog,
} from '../../../middleware/shared/ports/compiler-platform-port'
import type { StructuredCompileError } from '../../../middleware/shared/ports/types'
import type { BoardHalsCompileEntry } from '../firmware/build-arduino-cli-args'
import { buildKnownPous, emitCompileErrorEvents } from '../library/program-build-helpers'
import { runProgramBuildPipeline } from '../library/program-build-pipeline'
import type { DevicePin } from '../types/PLC/devices'
// PLCProjectData is read from the schema-shape type (singular `configuration`)
// because that's the runtime shape the editor's pipeline operates on.
// The web adapter currently keeps the renderer store in the port-shape
// (plural `configurations`) and converts at the pipeline entry — see C1
// in the architectural plan.
import type { PLCProjectData } from '../types/PLC/open-plc'
import { findEmptyFbdVariables } from './steps/validate-empty-variables'

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * Stages the pipeline emits during a single run.  Each stage carries
 * an info / warning / error message and (for compile errors) the
 * structured `compileError` payload the renderer's click-to-navigate
 * keys off.
 */
export interface PipelineProgressEvent {
  stage:
    | 'preprocess'
    | 'validate'
    | 'xml'
    | 'st'
    | 'strucpp'
    | 'confs'
    | 'firmware-bundle'
    | 'runtime-v4-bundle'
    | 'embed-c-blocks'
    | 'core-install'
    | 'lib-install'
    | 'arduino-compile'
    | 'runtime-version'
    | 'upload'
    | 'done'
    | 'error'
  message: string
  level: 'info' | 'warning' | 'error'
  compileError?: StructuredCompileError
}

/**
 * Slice of a `hals.json` board entry the pipeline reads.  Superset
 * of `BoardHalsCompileEntry` (used by `buildArduinoCliCompileArgs`)
 * plus the optional `define` field used by `generateDefinesContent`.
 * Caller passes the relevant entry from its platform's `hals.json`;
 * both platforms ship a byte-identical `hals.json` so the entry
 * shape is the same.
 */
export interface BoardHalsBuildEntry extends BoardHalsCompileEntry {
  /** Per-board #defines, fed through to `generateDefinesContent` as
   *  the `// Board defines` section. */
  define?: string | string[]
  /** Per-board arduino-cli library list.  Sourced from `hals.json`
   *  `extra_libraries` (static boards) and from VPP manifests'
   *  `device.hal.extraArduinoLibraries` (installed VPP boards) — the
   *  `BoardInfoResolver` collapses both onto the same key.  The
   *  pipeline forwards these into `installArduinoLib`, which on the
   *  editor runs `arduino-cli lib install <name>` and on the web
   *  no-ops (compile-service backend pre-installs every library).
   *
   *  Per-board libs are the contract: a board that needs the
   *  `Arduino_Opta_Blueprint` library declares it here, and the
   *  install fires only when that board is selected.  Boards that
   *  don't need a specific library never download it. */
  extra_libraries?: string[]
  /** Names of the device's configuration screens, and the physical transport it
   *  exposes. Forwarded from the VPP manifest so the pipeline can resolve the
   *  SAME Modbus profile the screen resolves — what the board can serve over is
   *  the board's to state, and the emitter had no access to it. */
  vppScreenNames?: string[]
  serialPorts?: string[]
  defaultSerial?: string
  networkInterfaces?: string[]
  /** Prebuilt arduino-hal (provisioning="prebuilt"): the precompiled Arduino
   *  library dir, linked via a 2nd `--library`. Present only for arduino
   *  prebuilt boards (the `source` HAL still compiles as the integration layer).
   *  Sourced from the VPP manifest `device.hal.precompiledLibrary`. */
  precompiledLibraryDir?: string
  /** Exact Arduino core version to install/verify before linking a prebuilt
   *  arduino library (ABI-locked). From the VPP manifest `target.coreVersion`. */
  coreVersion?: string
  /** Upload transport for arduino-cli targets. Absent/"serial" (default):
   *  serial-port upload. "ethernet": network upload, with the device IP passed
   *  as arduino-cli's `--port`. From `target.uploadMethod`. */
  uploadMethod?: 'serial' | 'ethernet'
  /** Vendor board-manager index (`package_<vendor>_index.json`).  From the
   *  VPP manifest `target.boardManagerUrl` or hals.json `board_manager_url`.
   *  Forwarded to `installArduinoCore`, which passes it to arduino-cli as
   *  `--additional-urls` so cores outside the built-in index resolve. */
  boardManagerUrl?: string
  /** Compiler / runtime identifier (`'arduino-cli' | 'openplc-compiler'
   *  | 'simulator'`).  Used by `resolveTargetCapabilities`'s
   *  preset lookup — without this the resolver can't pick the right
   *  capability defaults for the board. */
  compiler?: string
  /** Truthy when the board came from a VPP package.  Lets the
   *  capability resolver flip `vppIo` on for v4-derived VPP boards
   *  that didn't ship an explicit capability block. */
  vpp?: unknown
  /** Per-board capability overrides — same source-of-truth contract
   *  as the other per-board fields above.  Merged by
   *  `resolveTargetCapabilities` on top of the compiler preset, so a
   *  manifest can opt into `vppIo: true` without declaring the full
   *  block.  Critical for the Opta + future arduino-cli VPP boards:
   *  without forwarding this through the pipeline, `vppIo` resolves
   *  to false and `vpp_config.h` never gets generated, leaving the
   *  HAL with an unresolved `#include "vpp_config.h"`. */
  capabilities?: Partial<import('../../../middleware/shared/utils/target-capabilities/types').TargetCapabilities>
}

export interface RunCompilePipelineArgs {
  /** Source project (renderer-side store flat shape).  Pipeline
   *  internally preprocesses to canonical schema shape before
   *  threading through downstream steps. */
  projectData: PLCProjectData
  /** Board target identifier from the user's selection (e.g. `'OpenPLC
   *  Simulator'`, `'OpenPLC Runtime v4 (RPi)'`, `'Arduino Mega 2560'`). */
  boardTarget: string
  /** Runtime identifier from the matching `hals.json` entry:
   *  `'simulator'` (avr8js), `'arduino-cli'` (direct Arduino board),
   *  `'openplc-compiler'` (runtime v4 vPLC). */
  boardRuntime: string
  /** Resolved `hals.json` entry for `boardTarget`.  Carries the
   *  per-board `define` field consumed by `generateDefinesContent`
   *  and the `platform` / c_flags / cxx_flags arduino-cli passes
   *  through. */
  boardEntry: BoardHalsBuildEntry
  /** Pin mappings parsed from `devices/pin-mapping.json`.  Threaded
   *  through to `generateDefinesContent` for the `PINMASK_*` and
   *  `NUM_*` defines. */
  devicePinMapping: DevicePin[]
  /** `true` when the user picked the simulator board.  Drives whether
   *  the pipeline returns after arduino-cli compile (simulator) or
   *  goes on to upload (physical Arduino). */
  isSimulator: boolean
  /** `true` when the runtime is the OpenPLC v4 vPLC (boardRuntime
   *  `'openplc-compiler'` + `boardTarget !== 'OpenPLC Runtime v3'`).
   *  Drives the v4 bundle path (composeRuntimeV4Bundle + uploadRuntimeV4). */
  isRuntimeV4: boolean
  /** `true` when the runtime is the legacy v3 (boardTarget ===
   *  `'OpenPLC Runtime v3'`).  Drives the v3 embed-c-blocks path. */
  isRuntimeV3: boolean
  /** `true` when the caller only wants a compile, no upload.  The
   *  pipeline still runs through every step but returns before the
   *  upload phase. */
  compileOnly: boolean
  /** Pre-loaded `.stlib` archives the strucpp compile needs.
   *  Resolved by the adapter (editor: from `node_modules/strucpp/lib`
   *  + user-installed pool; web: from bundled assets). */
  libraryArchives: unknown[]
  /** Library names the project enables but couldn't be resolved.
   *  Strucpp's pre-compile gate fails fast on these with a clear
   *  message. */
  missingLibraries: string[]
  /** Firmware skeleton — bundled `Baremetal.ino`, Arduino HAL,
   *  strucpp runtime headers, simulator HAL adapter.  Editor: from
   *  filesystem; web: from `import.meta.glob`.  Contents byte-
   *  identical between repos. */
  firmwareSkeleton: Record<string, string>
  /** Strucpp runtime headers keyed under `strucpp_runtime/include/<filename>`.
   *  Only used by `composeRuntimeV4Bundle`; pass empty for the
   *  simulator path. */
  strucppRuntimeHeaders: Record<string, string>
  /** Server-resolved path to the avr-libstdcpp include directory.
   *  Threaded through to `buildArduinoCliCompileArgs`.  Empty string
   *  when not applicable (e.g. non-AVR cores). */
  avrLibStdCppInclude: string
  /** When `false`, arduino-cli runs with `--jobs 1` (web sandbox
   *  default).  When `true`, defaults to `--jobs 0` (editor's
   *  use-every-core). */
  arduinoCliParallel: boolean
  /** Device context for upload steps.  `undefined` when the caller
   *  is compile-only or the runtime upload step won't run.  The
   *  pipeline never inspects this — it just forwards through. */
  deviceContext?: PlatformDeviceContext
  /** Serial port to hand to `arduino-cli upload --port` when the
   *  build targets a physical Arduino board.  Captured from the
   *  user's device-board UI picker — the renderer reads it from the
   *  store at compile time and passes it through unchanged.  When
   *  absent (older callers, runtime v4 / simulator paths), the
   *  pipeline still threads `''` through so the editor adapter can
   *  fall back to its legacy `devices/configuration.json` disk
   *  read.  Ignored entirely on simulator + runtime-v3/v4 branches. */
  communicationPort?: string
  /** Device IP for a board whose VPP declares `uploadMethod: "ethernet"` — the
   *  ethernet counterpart of `communicationPort`, and handled the same way: the
   *  caller's value (the CLI's `--host`, the store's in the GUI) is preferred
   *  by the adapter over the project file's persisted `runtimeIpAddress`, which
   *  lags whatever the user just asked for. Absent on every serial board. */
  runtimeIpAddress?: string
  /** Optional cache hook for the strucpp debug-map.json bytes — the
   *  debugger reads these out of memory to map debug variable
   *  addresses without re-reading the file.  Called once per
   *  successful strucpp compile. */
  cacheDebugData?: (md5: string, debugMapJson: string) => void
  /**
   * This editor's own version, compared against the `minEditorVersion`
   * a runtime publishes at `GET /api/capabilities` (DOPE-448).
   *
   * Injected rather than imported: `APP_VERSION` lives in
   * `frontend/data/`, and the layer rules forbid `backend/shared/`
   * from reaching into `data` — correctly, since which build is
   * running is a fact about the host app, not about the compile.
   *
   * Absent means the caller opts out of the check, so the gate is
   * inert for callers written before it existed.
   */
  editorVersion?: string
  /** Persisted VPP Modbus screen state for the target device,
   *  sourced from `DeviceConfiguration.vendorScreenData` under
   *  the `modbus_rtu` / `modbus_tcp` keys.  Threaded straight
   *  through to `generateDefinesContent`, which emits the
   *  matching `MBSERIAL_*` / `MBTCP_*` macros for non-simulator
   *  Arduino targets.  Web passes `undefined` until the VPP
   *  Modbus screen lands on the web build. */
  vppModbusState?: import('./steps/modbus-defines').VppModbusScreenState
  /** The project's persistent-storage (RETAIN) settings, from
   *  `DeviceConfiguration.persistentStorage`.  Emitted into the
   *  runtime-v4 bundle as `retain.conf`, which the upload installs
   *  on the device.  Absent for a project that never configured
   *  storage — see `generateRetainConf`, where absence is a
   *  meaningful answer rather than a missing input. */
  persistentStorage?: import('../../../middleware/shared/ports/types').PersistentStorageSettings
  /** True when the selected target's VPP declares that its own driver
   *  handles retention (`hidesNativeScreens` includes
   *  `'persistent-storage'`).  Suppresses `retain.conf` entirely, which
   *  is what makes the runtime remove any copy the device still has and
   *  leaves the vendor's driver as the only store. */
  targetHidesPersistentStorage?: boolean
  /** User-authored configuration-screen data from
   *  `DeviceConfiguration.vendorScreenData`.  The platform adapter
   *  reads `devices/configuration.json` (editor) or the store (web)
   *  and forwards the `vendorScreenData` field as-is.  Threaded into
   *  the shared `generateVppConfigContent` helper for arduino-cli
   *  boards whose VPP package declares `vppIo: true` (Arduino Opta,
   *  P1AM).  When `vppIo` resolves to `false` or this field is
   *  absent, the pipeline skips `vpp_config.h` emission and the
   *  firmware skeleton's placeholder stays.
   *
   *  Deliberately the only adapter-specific input the VPP-config
   *  flow needs — `vppIo` itself is derived inside the pipeline by
   *  `resolveTargetCapabilities(boardEntry)`, keeping capability
   *  semantics in one place. */
  vendorScreenData?: Record<string, unknown>
}

export interface RunCompilePipelineResult {
  success: boolean
  /** Structured strucpp diagnostics from this run.  Carries
   *  the per-error events the renderer's navigation keys off. */
  errors?: StructuredCompileError[]
  /** Compiled firmware bytes when the pipeline reached the
   *  arduino-cli compile step successfully.  `undefined` when the
   *  pipeline targeted runtime v4 (no arduino-cli step) or failed
   *  before compile.  Caller decides what to do with these bytes
   *  (editor: write to `Baremetal.ino.hex`; web: feed avr8js). */
  binary?: Uint8Array
  /** MD5 of the strucpp-compiled `program.st`.  Echoed back so
   *  callers can use it as a cache key (defines.h PROGRAM_MD5
   *  refers to it). */
  md5?: string
  /** `true` when an upload step ran successfully (runtime v4 upload,
   *  arduino direct upload, or runtime v3 upload).  `false` when
   *  the pipeline returned via `compileOnly` or before reaching
   *  upload. */
  uploaded?: boolean
}

// ---------------------------------------------------------------------------
// Internal: emit helpers
// ---------------------------------------------------------------------------

function makePlatformLog(
  emit: (event: PipelineProgressEvent) => void,
  stage: PipelineProgressEvent['stage'],
): PlatformLog {
  return (message, level) => emit({ stage, message, level })
}

// ---------------------------------------------------------------------------
// Internal: bail helpers (single point for the "stop the pipeline" message)
// ---------------------------------------------------------------------------

function bailError(
  emit: (event: PipelineProgressEvent) => void,
  stage: PipelineProgressEvent['stage'],
  message: string,
  errors?: StructuredCompileError[],
): RunCompilePipelineResult {
  emit({ stage, message, level: 'error' })
  emit({ stage: 'error', message: 'Stopping compilation process.', level: 'error' })
  return { success: false, errors }
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full compile pipeline for a single project.  Branches on
 * `isRuntimeV4` / `isRuntimeV3` / `isSimulator` to drive the four
 * editor-canonical paths:
 *
 *   - Runtime v4 (openplc-compiler runtime): preprocess → XML → ST →
 *     strucpp → confs → composeRuntimeV4Bundle → version check →
 *     uploadRuntimeV4.
 *   - Simulator (avr8js):                   preprocess → XML → ST →
 *     strucpp → defines → composeFirmwareBundle → installCore/Lib
 *     (no-op on web) → compileArduino → return hex.
 *   - Arduino direct (physical board):     same as simulator, then
 *     uploadArduinoBoard.
 *   - Runtime v3 (legacy):                  preprocess → XML → ST →
 *     strucpp → embed c-blocks → uploadRuntimeV3.
 *
 * Each branch returns the canonical `RunCompilePipelineResult`
 * shape — `success`, `errors`, `binary`, `md5`, `uploaded` — that
 * adapters surface to their `CompilerPort` callers.
 */
export async function runCompilePipeline(
  args: RunCompilePipelineArgs,
  port: CompilerPlatformPort,
  emit: (event: PipelineProgressEvent) => void,
): Promise<RunCompilePipelineResult> {
  try {
    return await runCompilePipelineInner(args, port, emit)
  } catch (error) {
    // Any unhandled throw (data shape mismatch, port impl crash,
    // strucpp module load failure) surfaces here as a single error
    // event so the renderer's IPC channel doesn't hang waiting on a
    // success/failure that never arrives.
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    emit({ stage: 'error', message: `Unhandled pipeline error: ${message}`, level: 'error' })
    emit({ stage: 'error', message: 'Stopping compilation process.', level: 'error' })
    return { success: false }
  }
}

async function runCompilePipelineInner(
  args: RunCompilePipelineArgs,
  port: CompilerPlatformPort,
  emit: (event: PipelineProgressEvent) => void,
): Promise<RunCompilePipelineResult> {
  // ONE target, by construction: this fork serves OpenPLC Runtime v3
  // (docs/STELLARIA-V3.md). Anything else - the Runtime v4 container, the
  // in-process simulator, or a board flashed as firmware - is refused HERE, by
  // name, before any work: those paths were dismantled with strategy 2. A build
  // that quietly produced artefacts for a target this editor no longer serves
  // would be worse than a refusal that says which target to pick - and the
  // Arduino path compiles and flashes for real, so it must fail before anything
  // is written.
  if (!args.isRuntimeV3) {
    const what = args.isRuntimeV4 ? 'Runtime v4' : args.isSimulator ? 'Simulator' : `board "${args.boardTarget}"`
    return bailError(
      emit,
      'validate',
      `This editor serves OpenPLC Runtime v3 only - "${what}" is no longer supported. Point the project at "OpenPLC Runtime v3".`,
    )
  }

  const { projectData, isRuntimeV3, compileOnly, libraryArchives, missingLibraries, deviceContext, cacheDebugData } =
    args

  // Resolve the board's effective capabilities from `boardEntry`.
  // Single source of truth — the same helper that gates the
  // backplane UI in the renderer.  `boardEntry` may not be typed as
  // BoardInfoLike, but the runtime shape (capabilities + compiler +
  // optional vpp flag) is compatible — the resolver only reads
  // those fields and treats unknowns as missing.

  // ---------------------------------------------------------------------
  // Step 0: Use the already-preprocessed project data.
  //
  // Preprocessing (Python POU → ST stub conversion + C/C++ POU
  // sidecar extraction) runs on each platform's renderer side
  // BEFORE the pipeline is called — editor does it in the
  // compile-action that posts the IPC message, web does it in its
  // compile-adapter before invoking the pipeline.  Doing it again
  // here would double-process the data (and on editor the IPC
  // shape-conversion makes preprocessPous's port-shape assumptions
  // fail at runtime).  The pipeline trusts that `projectData.pous`
  // are already in ST form and that `originalCppPous` is attached
  // when the project has C/C++ POUs.
  // ---------------------------------------------------------------------
  const processedData = projectData as PLCProjectData & {
    originalCppPous?: Array<{ name: string; code: string; variables: unknown[] }>
  }
  const originalCppPous = processedData.originalCppPous ?? []

  // ---------------------------------------------------------------------
  // Step 0b: Reject blank FBD variable blocks before XML generation.
  //
  // An unnamed FBD in/out variable has no expression for the ST
  // transpiler to emit, producing invalid code downstream.  Catch it
  // here and tell the user exactly which POU to fix.
  // ---------------------------------------------------------------------
  const emptyVariables = findEmptyFbdVariables(processedData)
  if (emptyVariables.length > 0) {
    for (const variable of emptyVariables) {
      const where =
        variable.connectedTo !== null ? `connected to ${variable.connectedTo}` : `at x=${variable.x}, y=${variable.y}`
      emit({
        stage: 'validate',
        message: `POU "${variable.pouName}": an FBD ${variable.kind} variable block has no name (${where}). Name it before compiling.`,
        level: 'error',
      })
    }
    return bailError(emit, 'validate', 'Compilation aborted: name all variable blocks and try again.')
  }

  // ---------------------------------------------------------------------
  // A firmware build serves exactly one Modbus slave: `modbus.slaveid` is a
  // single global and `init_mbregs` is called once. The editor lets a project
  // carry several on purpose, because a project moves between targets, so the
  // refusal lands here rather than at creation — and it names them, because
  // "only one server is allowed" leaves the user to guess which to turn off.
  // ---------------------------------------------------------------------
  // Step 1: Transpile the project IR straight to Structured Text via
  // the platform port.  Both adapters (editor + web) route through
  // the in-process JSON-fed transpiler (`st-transpiler/`),
  // so this hop never builds PLCOpen XML.  Native STRUCT declarations
  // are the only emission mode the transpiler supports — the legacy
  // matiec struct→FB rewrite isn't ported, so there are no
  // equivalents of the old struct-rewrite flags.
  // ---------------------------------------------------------------------
  emit({ stage: 'st', message: 'Generating Structured Text...', level: 'info' })
  // The pipeline carries the editor's schema-shape `PLCProjectData`,
  // but the port's `transpileToSt` is typed against the renderer's
  // port-shape (`middleware/shared/ports/types`).  The two diverge in
  // POU layout (discriminated union vs. flat record) and configuration
  // field name (`configuration` vs. `configurations`).  Each platform
  // port impl knows which shape it actually receives — desktop/editor
  // routes through `fromSchemaShape`; web routes through `fromPortShape`
  // after converting at the adapter boundary.  Casting to `never` here
  // erases the structural mismatch without losing runtime fidelity.
  const stResult = await port.transpileToSt({ projectData: processedData as never }, makePlatformLog(emit, 'st'))
  if (!stResult.ok || !stResult.programSt) {
    if (stResult.errors && stResult.errors.length > 0) {
      emitCompileErrorEvents(
        stResult.errors.map((e) => ({ formatted: e.message, raw: e as unknown as never })),
        (msg, level, compileError) => emit({ stage: 'st', message: msg, level, compileError }),
      )
    }
    return bailError(emit, 'st', 'Failed to generate Structured Text', stResult.errors)
  }
  const programSt = stResult.programSt

  // ---------------------------------------------------------------------
  // Step 3: Strucpp compile.  Emits generated.cpp/hpp,
  // generated_debug.cpp, debug-map.json, per-POU *.cpp splits, and the
  // program.st.map.json offset map.
  // ---------------------------------------------------------------------
  emit({ stage: 'strucpp', message: 'Compiling Structured Text to C++ with STruC++...', level: 'info' })
  const hasCBlocks = originalCppPous.length > 0
  // `buildKnownPous` is typed against the port-shape `PLCPou`; cast
  // through `never` for the same reason described in Step 0.
  const knownPous = buildKnownPous(processedData.pous as never)
  // MD5 of program.st — the runtime embeds this into defines.h via
  // `generateDefinesContent` for stale-program detection.  Each
  // platform's adapter implements `computeMd5` (editor: Node crypto;
  // web: spark-md5) so the shared module doesn't carry a
  // heavyweight hash dependency.  Both implementations produce
  // byte-identical hex.
  const md5 = await port.computeMd5(programSt)
  const strucppResult = runProgramBuildPipeline({
    source: programSt,
    md5,
    pous: knownPous,
    libraries: libraryArchives,
    missingLibraries,
    hasCBlocks,
  })
  if (strucppResult.splitterFallbackMessage) {
    emit({ stage: 'st', message: strucppResult.splitterFallbackMessage, level: 'info' })
  }
  if (!strucppResult.success) {
    emitCompileErrorEvents(strucppResult.errors, (msg, level, compileError) =>
      emit({ stage: 'st', message: msg, level, compileError }),
    )
    return bailError(emit, 'strucpp', 'STruC++ compilation failed')
  }
  for (const warn of strucppResult.warnings) {
    emit({ stage: 'st', message: warn.formatted ?? 'unknown warning', level: 'warning' })
  }
  if (strucppResult.debugMapSummary) {
    emit({ stage: 'st', message: strucppResult.debugMapSummary, level: 'info' })
  }

  // Cache the debug-map.json bytes so the debugger can map variable
  // addresses without re-reading them from disk later.
  const strucppFilesMap: Record<string, string> = {}
  for (const file of strucppResult.files) {
    strucppFilesMap[file.name] = file.content
  }
  const debugMapJson = strucppFilesMap['debug-map.json'] ?? ''
  if (cacheDebugData) {
    cacheDebugData(md5, debugMapJson)
  }

  // ---------------------------------------------------------------------
  // Step 4b: Runtime v3 branch — legacy target that ingests a single
  // `program.st` (not a zip).  v3's on-device MatIEC recompiles the ST
  // itself, so this MUST short-circuit BEFORE the arduino-cli path
  // (core/lib install, firmware bundle, compile) — none of which apply
  // to v3.  (Placing it after `installArduinoCore` was the bug: v3 has
  // no Arduino core, so the install ran with an empty FQBN and aborted
  // the build before the upload was ever reached.)
  //
  // Strucpp already ran above purely as a correctness check; a strucpp
  // error bails before we get here, which is the desired behaviour
  // (catch user code errors without an on-device round-trip).
  //
  // C/C++ and Python function blocks are NOT supported on v3 — they
  // lower to strucpp `{external ...}` inline-C that v3's MatIEC can't
  // parse — and are rejected up front by the editor compile adapter
  // before this pipeline runs (see `createEditorCompilerAdapter`).  So
  // the ST that reaches here is plain IEC that MatIEC accepts; we just
  // upload it verbatim.
  // ---------------------------------------------------------------------
  if (isRuntimeV3) {
    // The editor's debug session, and the CLI, read the index off disk
    // (`<project>/build/<target>/src/debug-map.json`), and this branch writes
    // nothing there: the target recompiles the ST for itself. Persist the two
    // inputs the index is built from — before the compile-only return, because
    // `openplc-cli compile` is exactly that case.
    if (port.persistRuntimeV3Sources) {
      await port.persistRuntimeV3Sources({ programSt, debugMapJson }, makePlatformLog(emit, 'st'))
    }
    if (compileOnly) {
      emit({ stage: 'done', message: 'Compile only mode — skipping upload to runtime v3.', level: 'info' })
      return { success: true, md5, uploaded: false }
    }
    if (!deviceContext) {
      emit({
        stage: 'upload',
        message: 'Runtime v3 not configured. Skipping upload.',
        level: 'warning',
      })
      return { success: true, md5, uploaded: false }
    }

    emit({ stage: 'upload', message: 'Uploading program.st to Runtime v3...', level: 'info' })
    const uploadResult = await port.uploadRuntimeV3(
      { programSt, context: deviceContext },
      makePlatformLog(emit, 'upload'),
    )
    if (!uploadResult.ok) {
      return bailError(emit, 'upload', 'Failed to upload to Runtime v3.', uploadResult.errors)
    }
    emit({ stage: 'done', message: 'Runtime v3 upload complete.', level: 'info' })
    return { success: true, md5, uploaded: true }
  }

  /* The guard above admits Runtime v3 only, and that branch always returns.
   * This line exists so the function has no fall-through path. */
  return bailError(emit, 'validate', 'Unreachable: this editor serves OpenPLC Runtime v3 only.')
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
