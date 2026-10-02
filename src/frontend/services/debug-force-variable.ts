import type { DebuggerPort } from '../../middleware/shared/ports/debugger-port'
import { useOpenPLCStore } from '../store'
import { applySwapToVariableBytes } from '../utils/endian'

/**
 * What a force actually needs from the debugger: the force/release call, and
 * nothing else. Narrowing the parameter to this keeps the dependency honest and
 * lets a test pass a two-line stand-in without asserting its way past the real
 * interface. The callers all hold a full `DebuggerPort`, which satisfies it.
 */
export type ForceTransport = Pick<DebuggerPort, 'setVariable'>

/**
 * One line per force attempt, on the wire's terms.
 *
 * The runtimes log what they RECEIVE (`Debug: FC42 force idx=N flag=F len=L`),
 * so the only thing a stuck force never told anyone was what the editor SENT
 * and whether the port accepted it: every path below used to end in a boolean
 * nobody looked at. With this line, "I pressed Force and nothing happened" is
 * answerable from the Console panel instead of by re-reading the UI code.
 */
function logForceAttempt(compositeKey: string, debugIndex: number, payload: string, success: boolean): void {
  useOpenPLCStore.getState().consoleActions.addLog({
    level: success ? 'info' : 'error',
    message: `[force] ${compositeKey} idx=${debugIndex} ${payload} -> ${success ? 'accepted by the debug port' : 'REJECTED by the debug port'}`,
  })
}

/**
 * Force a variable to a specific value via the debug protocol, then update
 * the store's forced-variables Map on success.
 *
 * Uses `useOpenPLCStore.getState()` for imperative (non-hook) access so it is
 * safe to call from async event handlers without stale-closure issues.
 *
 * The optional `typeName` (canonical IEC, e.g. `'REAL'`, `'DINT'`) drives
 * the wire-endianness swap before the bytes leave the editor.  BOOL
 * force paths construct a one-byte buffer inline and don't need to
 * pass a type — the swap is a no-op on single bytes anyway.  STRING /
 * WSTRING buffers carry a length byte + raw bytes and are exempt from
 * swapping.
 */
export async function forceDebugVariable(
  debuggerPort: ForceTransport,
  compositeKey: string,
  debugIndex: number | undefined,
  valueBuffer: Uint8Array,
  forcedMapValue: boolean,
  typeName?: string,
): Promise<boolean> {
  if (debugIndex === undefined) {
    // Nothing to address the force to. Saying so is the difference between a
    // five-second answer and an afternoon: several UI paths call this with an
    // index they could not resolve, and a bare `false` hides all of them.
    useOpenPLCStore.getState().consoleActions.addLog({
      level: 'error',
      message: `[force] ${compositeKey} ignored: no debug index for this variable (is the debug session open on this program?).`,
    })
    return false
  }

  // Editor's internal codec produces LE bytes; swap to target-native
  // here if the target is BE.  No-op for LE targets and for
  // single-byte / string buffers.
  const { debugTargetEndian } = useOpenPLCStore.getState().workspace
  if (typeName !== undefined) {
    applySwapToVariableBytes(valueBuffer, 0, valueBuffer.length, typeName, debugTargetEndian)
  } else if (debugTargetEndian === 'be' && valueBuffer.length > 1) {
    // No type hint — apply a plain byte-reverse for safety.  Callers
    // that produce single-byte buffers (BOOL) hit the length guard
    // and skip; multi-byte buffers reach the runtime in target order.
    // String-like callers must pass `typeName` to opt out.
    applySwapToVariableBytes(valueBuffer, 0, valueBuffer.length, 'BYTES', debugTargetEndian)
  }

  const result = await debuggerPort.setVariable(debugIndex, true, valueBuffer)
  logForceAttempt(
    compositeKey,
    debugIndex,
    `bytes=[${[...valueBuffer].map((b) => b.toString(16).padStart(2, '0')).join(' ')}]`,
    result.success,
  )
  if (result.success) {
    const state = useOpenPLCStore.getState()
    const newForced = new Map(state.workspace.debugForcedVariables)
    newForced.set(compositeKey, forcedMapValue)
    state.workspaceActions.setDebugForcedVariables(newForced)
  }
  return result.success
}

/**
 * Release a forced variable via the debug protocol, then remove it from
 * the store's forced-variables Map on success.
 */
export async function releaseDebugVariable(
  debuggerPort: ForceTransport,
  compositeKey: string,
  debugIndex: number | undefined,
): Promise<boolean> {
  if (debugIndex === undefined) {
    useOpenPLCStore.getState().consoleActions.addLog({
      level: 'error',
      message: `[force] ${compositeKey} release ignored: no debug index for this variable.`,
    })
    return false
  }

  const result = await debuggerPort.setVariable(debugIndex, false)
  logForceAttempt(compositeKey, debugIndex, 'release', result.success)
  if (result.success) {
    const state = useOpenPLCStore.getState()
    const newForced = new Map(state.workspace.debugForcedVariables)
    newForced.delete(compositeKey)
    state.workspaceActions.setDebugForcedVariables(newForced)
  }
  return result.success
}
