/**
 * The force service is the single funnel every UI path goes through — the watch
 * panel's context menu ("Force True" / "Force False" / "Release Force"), the
 * "Force Value" dialog, and the ladder/FBD editors. These tests pin the two
 * things that were invisible before: the exact call it makes, and the fact that
 * a force it cannot address now SAYS so instead of returning quietly.
 *
 * The store is faked rather than imported: the real one is frozen, so its slice
 * actions cannot be spied on, and a fake makes the assertions describe the
 * service's contract instead of Zustand's wiring.
 */
const mockLogs: { level: string; message: string }[] = []
const mockState = {
  workspace: {
    debugForcedVariables: new Map<string, boolean>(),
    debugTargetEndian: 'le',
  },
  workspaceActions: {
    setDebugForcedVariables: (next: Map<string, boolean>) => {
      mockState.workspace.debugForcedVariables = next
    },
  },
  consoleActions: {
    addLog: (entry: { level: string; message: string }) => {
      mockLogs.push(entry)
    },
  },
}

jest.mock('../../store', () => ({
  useOpenPLCStore: {
    getState: () => mockState,
  },
}))

import { forceDebugVariable, releaseDebugVariable } from '../../services/debug-force-variable'

describe('forceDebugVariable', () => {
  const forced = () => mockState.workspace.debugForcedVariables

  beforeEach(() => {
    mockState.workspace.debugForcedVariables = new Map()
    mockLogs.length = 0
  })

  it('forces with the given index and bytes, and marks the variable forced', async () => {
    const setVariable = jest.fn().mockResolvedValue({ success: true })

    const ok = await forceDebugVariable({ setVariable }, 'main:led', 2, new Uint8Array([1]), true, 'BOOL')

    expect(ok).toBe(true)
    expect(setVariable).toHaveBeenCalledWith(2, true, new Uint8Array([1]))
    expect(forced().get('main:led')).toBe(true)
  })

  /** Force-to-false is a force, not a release: the mark must survive as `false`. */
  it('keeps a force to zero distinguishable from no force at all', async () => {
    const setVariable = jest.fn().mockResolvedValue({ success: true })

    await forceDebugVariable({ setVariable }, 'main:led', 2, new Uint8Array([0]), false, 'BOOL')

    expect(setVariable).toHaveBeenCalledWith(2, true, new Uint8Array([0]))
    expect(forced().get('main:led')).toBe(false)
  })

  it('leaves the variable unmarked when the port refuses the force', async () => {
    const setVariable = jest.fn().mockResolvedValue({ success: false })

    const ok = await forceDebugVariable({ setVariable }, 'main:led', 2, new Uint8Array([1]), true, 'BOOL')

    expect(ok).toBe(false)
    expect(forced().has('main:led')).toBe(false)
  })

  /** Every attempt is on the record, with the bytes that went out. */
  it('records what left the editor, with its index and bytes', async () => {
    const setVariable = jest.fn().mockResolvedValue({ success: true })

    await forceDebugVariable({ setVariable }, 'main:led', 2, new Uint8Array([1]), true, 'BOOL')

    expect(mockLogs).toEqual([expect.objectContaining({ level: 'info', message: expect.stringContaining('idx=2') })])
    expect(mockLogs[0].message).toContain('bytes=[01]')
  })

  /**
   * The silent version of this cost hours: several UI paths call with an index
   * they could not resolve, and a bare `false` left nothing to look at.
   */
  it('names the reason when there is no index to send to', async () => {
    const setVariable = jest.fn()

    const ok = await forceDebugVariable({ setVariable }, 'main:led', undefined, new Uint8Array([1]), true)

    expect(ok).toBe(false)
    expect(setVariable).not.toHaveBeenCalled()
    expect(mockLogs).toEqual([
      expect.objectContaining({
        level: 'error',
        message: expect.stringContaining('no debug index for this variable'),
      }),
    ])
  })

  it('releases through the port and clears the mark', async () => {
    mockState.workspace.debugForcedVariables = new Map([['main:led', true]])
    const setVariable = jest.fn().mockResolvedValue({ success: true })

    const ok = await releaseDebugVariable({ setVariable }, 'main:led', 2)

    expect(ok).toBe(true)
    expect(setVariable).toHaveBeenCalledWith(2, false)
    expect(forced().has('main:led')).toBe(false)
  })
})
