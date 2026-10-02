/**
 * `getAvailableBoards()` is the only path from `hals.json` to the capability
 * matrix the debug-channel resolver reads. An entry that declares its own
 * `capabilities` must come out of it with that block intact: dropping it left
 * Runtime v3 with the v4 profile (`debuggerTransports: ['websocket']`), so its
 * only channel — Modbus TCP — was discarded and no debug link was described at
 * all (ERR-062).
 */
import { getHalsFile } from '@root/backend/shared/firmware/hals-loader'

import { HardwareModule } from '../hardware-module'

jest.mock('electron', () => ({ app: { getPath: jest.fn(() => '/mock/user-data'), isPackaged: false } }))
jest.mock('serialport', () => ({ SerialPort: { list: jest.fn().mockResolvedValue([]) } }))

describe('getAvailableBoards', () => {
  beforeEach(() => {
    // The arduino-core record is read off disk at `<userData>/User/Runtime/…`;
    // no assertion below depends on it.
    jest.spyOn(HardwareModule, 'readJSONFile').mockResolvedValue([])
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('carries the capability block each catalogue entry declares', async () => {
    const boards = await new HardwareModule().getAvailableBoards()
    const declared = getHalsFile<Record<string, { capabilities?: unknown }>>()['OpenPLC Runtime v3'].capabilities

    expect(declared).toBeDefined()
    expect(boards.get('OpenPLC Runtime v3')?.capabilities).toEqual(declared)
  })

  it('leaves Runtime v3 the transport its debug channel needs', async () => {
    const boards = await new HardwareModule().getAvailableBoards()

    expect(boards.get('OpenPLC Runtime v3')?.capabilities?.debuggerTransports).toContain('modbus-tcp')
  })

  it('declares a capability block for every board it ships', async () => {
    const boards = await new HardwareModule().getAvailableBoards()
    const declared = getHalsFile<Record<string, { capabilities?: unknown }>>()
    // Only the bundled catalogue: VPP boards arrive with their own manifest and
    // are merged in below this loop.
    const bundled = [...boards].filter(([name]) => name in declared)
    const missing = bundled.filter(([, board]) => board.capabilities === undefined).map(([name]) => name)

    expect(bundled.length).toBeGreaterThan(0)
    // A board with no block silently inherits the `compiler`-derived preset —
    // which is how Runtime v3 ended up declaring a WebSocket it cannot speak.
    expect(missing).toEqual([])
  })

  /**
   * ONE target, by construction (docs/STELLARIA-V3.md). The list is the bundled
   * catalogue and nothing else: installed `.vpp` packages are not merged in any
   * more, which is also what closed the last path from a project to the Runtime
   * v4 pipeline this fork has removed.
   */
  it('serves the bundled catalogue and nothing else', async () => {
    const boards = await new HardwareModule().getAvailableBoards()
    const declared = Object.keys(getHalsFile<Record<string, unknown>>())

    expect([...boards.keys()].sort()).toEqual(declared.sort())
    expect([...boards.keys()]).toEqual(['OpenPLC Runtime v3'])
  })
})
