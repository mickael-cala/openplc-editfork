/**
 * Debug Session Hook
 *
 * Manages the debug session lifecycle: read debug-map.json, build index/tree
 * maps, commit debug artifacts to the store, connect/disconnect via
 * DebuggerPort.
 *
 * Platform-agnostic — all protocol operations are delegated to the
 * DebuggerPort and SimulatorPort provided by the PlatformProvider.
 * The backend adapter decides the actual transport (IPC, HTTP, WebRTC, etc.).
 */

import { useCallback, useEffect, useRef } from 'react'

import type { DebugTreeNode, FbInstanceInfo } from '../../middleware/shared/ports/types'
import { useDebugger, useRuntime } from '../../middleware/shared/providers'
import { resolveTargetCapabilities } from '../../middleware/shared/utils/target-capabilities'
import { useOpenPLCStore } from '../store'
import { parseDebugMap } from '../utils/debug-parser'
import {
  applyExternalForces,
  declarationCompositeKey,
  functionBlockInstancePaths,
  projectV3DebugEntries,
  projectV3Declarations,
} from '../utils/debug-v3-projection'
import {
  buildDebugVariableTreeMap,
  buildFbInstanceMap,
  debugMapToEntries,
  deriveVariableIndexMap,
} from '../utils/debugger-session'
import { encodeForceValue } from '../utils/variable-sizes'

export interface UseDebugSessionReturn {
  /**
   * Connect to the debug target and start a debug session.
   *
   * Reads the debug file, parses it, builds variable index/tree/FB maps,
   * connects via the debugger port, stores all artifacts in workspace,
   * and activates the debugger UI.
   *
   * Takes nothing: the connection manager holds the session for every target by the
   * time a debug session can start, so there is no medium for a caller to name.
   */
  connectAndStart: () => Promise<{ success: boolean; error?: string }>

  /** Disconnect from the debug target and clear all debug state. */
  stopSession: () => Promise<void>

  /** Force or release a variable via the debugger port. */
  forceVariable: (index: number, force: boolean, valueHex?: string) => Promise<boolean>

  /** Debug tree nodes built for each POU, keyed by pouName. */
  debugTreesRef: React.MutableRefObject<Record<string, DebugTreeNode[]>>
}

/**
 * How often the backend's force registry is re-read while a session is open.
 *
 * Slow on purpose: the refresh exists so a force made (or released) from the web
 * page shows up on its own, and two seconds is comfortably below the time it
 * takes someone to look from one screen to the other. Each read costs the
 * backend one `GET /api/force`, and that costs the target one FC 0x45.
 */
const FORCE_REGISTRY_POLL_MS = 2000

export function useDebugSession(): UseDebugSessionReturn {
  const debuggerPort = useDebugger()
  const runtimePort = useRuntime()

  const {
    project: { data: projectData, meta: projectMeta },
    deviceDefinitions,
    workspaceActions,
    consoleActions,
  } = useOpenPLCStore()

  const debugTreesRef = useRef<Record<string, DebugTreeNode[]>>({})
  /** Keys the backend's registry contributed to `debugForcedVariables`. */
  const externalForcesRef = useRef<Set<string>>(new Set())
  /** Ordinal → composite key for this session, or null when the target is not
   *  one that indexes its own table (nothing to apply a registry to). */
  const externalForceIndexToKeyRef = useRef<Map<number, string> | null>(null)
  const forcePollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  /**
   * Re-read the backend's force registry and fold it into the store.
   *
   * A failure is cosmetic — the editor's own forces, and the debug channel, do
   * not depend on this — so a backend that predates the registry (WS-109) simply
   * never reports anything.
   */
  const refreshExternalForces = useCallback(async (): Promise<void> => {
    const indexToKey = externalForceIndexToKeyRef.current
    if (indexToKey === null) return
    try {
      const registry = await runtimePort.getForceRegistry()
      if (!registry.success || registry.forces === undefined) return
      const state = useOpenPLCStore.getState()
      const applied = applyExternalForces(
        state.workspace.debugForcedVariables,
        externalForcesRef.current,
        registry.forces,
        indexToKey,
      )
      externalForcesRef.current = applied.external
      state.workspaceActions.setDebugForcedVariables(applied.forced)
    } catch {
      // See above.
    }
  }, [runtimePort])

  useEffect(
    () => () => {
      if (forcePollRef.current !== null) clearInterval(forcePollRef.current)
    },
    [],
  )

  const connectAndStart = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    const { project, workspaceActions: wsActions, consoleActions: logActions } = useOpenPLCStore.getState()
    const boardTarget = deviceDefinitions.configuration.deviceBoard
    const projectPath = project.meta.path

    logActions.addLog({ level: 'info', message: 'Connecting debugger...' })

    try {
      const debugFileResult = await debuggerPort.readDebugFile(projectPath, boardTarget)
      if (!debugFileResult.success || !debugFileResult.content) {
        const error = `Failed to read debug-map.json: ${debugFileResult.error ?? 'No content'}`
        logActions.addLog({ level: 'error', message: error })
        return { success: false, error }
      }

      wsActions.setDebugCContent(debugFileResult.content)

      // A library-debug session runs against a generated harness program
      // that instantiates every block in the library — it exists only in
      // memory, so the POU list and instance list the debug tree is built
      // from come from the session overlay, not from `project.data`.  An
      // ordinary PLC project has no overlay and reads the project itself.
      // See `composeLibraryDebugHarness`.
      const harness = useOpenPLCStore.getState().workspace.debugHarness
      const debugPous = harness ? [...project.data.pous, harness.programPou] : project.data.pous
      const instances = harness?.instances ?? project.data.configurations.resource.instances

      const debugMap = parseDebugMap(debugFileResult.content)
      if (!debugMap) {
        const error = 'Invalid debug-map.json (expected schema version 2)'
        logActions.addLog({ level: 'error', message: error })
        return { success: false, error }
      }

      // A target reached over Modbus TCP indexes ITS OWN table — one entry per
      // declaration, FB instances absent — not STruC++'s finer-grained leaf
      // list, so the map is projected onto that table first. Sending STruC++'s
      // positions to such a target read and forced the wrong variable, and made
      // the FC 0x41 count check refuse the session as soon as the project had an
      // array or an FB (measured: docs/STELLARIA-V3-ROADMAP.md, D2).
      const boardInfo = useOpenPLCStore.getState().deviceAvailableOptions.availableBoards.get(boardTarget)
      const targetIndexesByOrdinal = resolveTargetCapabilities(boardInfo).debuggerTransports.includes('modbus-tcp')
      const entriesForTree = targetIndexesByOrdinal
        ? projectV3DebugEntries(debugMap, {
            functionBlockInstances: functionBlockInstancePaths(
              debugPous,
              instances,
              useOpenPLCStore.getState().libraries.system,
            ),
          })
        : debugMapToEntries(debugMap)
      logActions.addLog({
        level: 'info',
        message: targetIndexesByOrdinal
          ? `Debug map: ${debugMap.leaves.length} leaves projected onto ${entriesForTree.length} target entries.`
          : `Debug map: ${debugMap.leaves.length} leaves across ${debugMap.arrays.length} arrays.`,
      })

      // Build the debug variable tree — the single enumeration walk. The
      // composite-key → index map (used by the LD/FBD editors and the poller)
      // is derived from this same tree, so every consumer resolves a
      // variable's address identically.
      let treeMap = new Map<string, DebugTreeNode>()
      const pouTrees: Record<string, DebugTreeNode[]> = {}
      try {
        const treeResult = buildDebugVariableTreeMap(
          debugPous,
          instances,
          entriesForTree,
          { ...project.data, pous: debugPous },
          useOpenPLCStore.getState().libraries.system,
        )
        treeMap = treeResult.treeMap

        // Group trees by POU name for polling hook
        for (const node of treeResult.trees) {
          const pouName = node.compositeKey.split(':')[0]
          if (!pouTrees[pouName]) pouTrees[pouName] = []
          pouTrees[pouName].push(node)
        }

        for (const w of treeResult.warnings) {
          logActions.addLog({ level: 'warning', message: w })
        }

        logActions.addLog({
          level: 'info',
          message: `Debug tree builder: Built ${treeResult.trees.length} trees (${treeResult.complexCount} complex).`,
        })
      } catch {
        logActions.addLog({
          level: 'warning',
          message: 'Debug tree builder encountered errors.',
        })
      }

      debugTreesRef.current = pouTrees

      // Derive the composite-key → packed-address map from the tree leaves.
      const indexMap = deriveVariableIndexMap(treeMap, debugMap)

      // A force made from the web interface lives in the BACKEND's registry
      // (the runtime never says who forced what), and it appears — or disappears
      // — WHILE the session runs: someone forcing a variable from the web page
      // is the normal case, not the exception. So the registry is read once here
      // and then re-read on a slow timer; each refresh marks what the backend
      // holds and retires what it released, which is what lets the editor show
      // "forced" for a force it never made (P2).
      if (targetIndexesByOrdinal) {
        const functionBlockInstances = functionBlockInstancePaths(
          debugPous,
          instances,
          useOpenPLCStore.getState().libraries.system,
        )
        externalForceIndexToKeyRef.current = new Map(
          projectV3Declarations(debugMap, { functionBlockInstances })
            .map(
              (declaration) =>
                [declaration.index, declarationCompositeKey(declaration.declaration, debugPous, instances)] as const,
            )
            .filter((entry): entry is readonly [number, string] => entry[1] !== undefined),
        )
        externalForcesRef.current = new Set()
        await refreshExternalForces()
        if (forcePollRef.current === null) {
          forcePollRef.current = setInterval(() => void refreshExternalForces(), FORCE_REGISTRY_POLL_MS)
        }
      }

      // Build FB instance map
      const fbDebugInstancesMap = buildFbInstanceMap(debugPous, instances)

      const fbTypesCount = fbDebugInstancesMap.size
      const totalFbInstances = Array.from(fbDebugInstancesMap.values()).reduce((sum, list) => sum + list.length, 0)
      if (fbTypesCount > 0) {
        logActions.addLog({
          level: 'info',
          message: `FB instance map: Found ${totalFbInstances} instances across ${fbTypesCount} FB types.`,
        })
      }

      // Connect debugger via port
      const connectResult = await debuggerPort.connect()
      if (!connectResult.success) {
        const error = `Debugger connection failed: ${connectResult.error ?? 'Unknown error'}`
        logActions.addLog({ level: 'error', message: error })
        return { success: false, error }
      }

      // Store debug artifacts in workspace
      wsActions.setDebugVariableIndexes(indexMap)
      wsActions.setDebugVariableTree(treeMap)
      wsActions.setFbDebugInstances(fbDebugInstancesMap)

      // Set default selected instance for each FB type
      fbDebugInstancesMap.forEach((instanceList: FbInstanceInfo[], fbTypeName: string) => {
        if (instanceList.length > 0) {
          wsActions.setFbSelectedInstance(fbTypeName, instanceList[0].key)
        }
      })

      // Set target IP for non-simulator connections
      // The target's address, for the debugger's own display. Comes from the
      // session the manager holds, not from a config the caller chose.
      const sessionEndpoint = useOpenPLCStore.getState().deviceConnection.port
      if (sessionEndpoint) wsActions.setDebuggerTargetIp(sessionEndpoint)

      // Nothing to record about the transport: `useDebugPolling` reads the medium
      // the connection manager published (`deviceConnection.debugTransport`) and
      // derives both its batch size and its cadence from it. Copying that into a
      // second store field is what let the two disagree — and made a session whose
      // medium was not yet known silently poll as if it were the simulator.
      wsActions.setDebuggerVisible(true)
      logActions.addLog({
        level: 'info',
        message: `Debugger connected. Found ${indexMap.size} debug variables.`,
      })

      return { success: true }
    } catch (err: unknown) {
      const error = `Debugger error: ${err instanceof Error ? err.message : String(err)}`
      logActions.addLog({ level: 'error', message: error })
      return { success: false, error }
    }
  }, [debuggerPort, deviceDefinitions, projectData, projectMeta, refreshExternalForces])

  /**
   * End the debug session — and ONLY the debug session.
   *
   * It used to stop the simulator too, which had the ownership backwards: a debug
   * session is a consumer of a connection, not the owner of the thing on the other
   * end. Stopping the simulator is the Stop button's job (`handleSimulatorControl`),
   * and closing that session is the connection manager's.
   */
  const stopSession = useCallback(async () => {
    // The registry refresh belongs to this session: letting it run on would keep
    // marking variables as forced after the debugger is gone.
    if (forcePollRef.current !== null) {
      clearInterval(forcePollRef.current)
      forcePollRef.current = null
    }
    externalForcesRef.current = new Set()
    externalForceIndexToKeyRef.current = null

    await debuggerPort.disconnect()

    workspaceActions.clearDebugState()
    debugTreesRef.current = {}
  }, [debuggerPort, workspaceActions])

  const forceVariable = useCallback(
    async (index: number, force: boolean, value?: string, type?: string, enumValues?: string[]): Promise<boolean> => {
      let valueBuffer: Uint8Array | undefined
      if (force) {
        try {
          valueBuffer = encodeForceValue(value ?? '0', type ?? 'BOOL', enumValues)
        } catch (err) {
          consoleActions.addLog({
            level: 'error',
            message: `Force input error: ${err instanceof Error ? err.message : String(err)}`,
          })
          return false
        }
      }
      const result = await debuggerPort.setVariable(index, force, valueBuffer)
      if (result.success) {
        consoleActions.addLog({
          level: 'info',
          message: 'Variable force applied successfully',
        })
        return true
      } else {
        consoleActions.addLog({
          level: 'error',
          message: `Failed to set variable: ${result.error}`,
        })
        return false
      }
    },
    [debuggerPort, consoleActions],
  )

  return {
    connectAndStart,
    stopSession,
    forceVariable,
    debugTreesRef,
  }
}
