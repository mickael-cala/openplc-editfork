/**
 * The v3 projection is measured against the target's own table: the expected
 * lists below are what `tools/plcbuild/plcbuild.exe` writes into
 * `core/POUS.h` for the same programs (D2/J4.0 in
 * `docs/STELLARIA-V3-ROADMAP.md`).
 */
import type { DebugMap } from '../debug-parser'
import { declarationPathOf, projectV3DebugEntries } from '../debug-v3-projection'

function mapOf(...leaves: Array<{ path: string; type: string }>): DebugMap {
  return {
    version: 2,
    md5: 'test',
    typeTags: {},
    arrays: [{ index: 0, count: 8000 }],
    leaves: leaves.map((leaf, elemIdx) => ({ arrayIdx: 0, elemIdx, size: 2, ...leaf })),
  }
}

describe('declarationPathOf', () => {
  it.each([
    ['INSTANCE0.LED', 'INSTANCE0.LED'],
    ['INSTANCE0.ARR[0]', 'INSTANCE0.ARR'],
    ['INSTANCE0.ARR[2].FIELD', 'INSTANCE0.ARR'],
    ['INSTANCE0.TON1.Q', 'INSTANCE0.TON1'],
    ['INSTANCE0.FB1.FB2.FIELD', 'INSTANCE0.FB1'],
    ['GLOBAL_VAR', 'GLOBAL_VAR'],
  ])('%s -> %s', (path, expected) => {
    expect(declarationPathOf(path)).toBe(expected)
  })
})

describe('projectV3DebugEntries', () => {
  it('keeps a scalar program as it is (measured: 5 leaves = 5 target entries)', () => {
    const map = mapOf(
      { path: 'INSTANCE0.DEMARRER', type: 'BOOL' },
      { path: 'INSTANCE0.LED', type: 'BOOL' },
      { path: 'INSTANCE0.CLIGNOTE', type: 'BOOL' },
      { path: 'INSTANCE0.SECONDES', type: 'UINT' },
      { path: 'INSTANCE0.TICKS', type: 'UINT' },
    )

    expect(projectV3DebugEntries(map).map((entry) => [entry.index, entry.name])).toEqual([
      [0, 'INSTANCE0.DEMARRER'],
      [1, 'INSTANCE0.LED'],
      [2, 'INSTANCE0.CLIGNOTE'],
      [3, 'INSTANCE0.SECONDES'],
      [4, 'INSTANCE0.TICKS'],
    ])
  })

  it('collapses an array to one entry and renumbers (measured: target lists LED, ARR, N)', () => {
    const map = mapOf(
      { path: 'INSTANCE0.LED', type: 'BOOL' },
      { path: 'INSTANCE0.ARR[0]', type: 'INT' },
      { path: 'INSTANCE0.ARR[1]', type: 'INT' },
      { path: 'INSTANCE0.ARR[2]', type: 'INT' },
      { path: 'INSTANCE0.N', type: 'INT' },
    )
    const entries = projectV3DebugEntries(map)

    expect(entries.map((entry) => [entry.index, entry.name])).toEqual([
      [0, 'INSTANCE0.LED'],
      [1, 'INSTANCE0.ARR'],
      // The map's elemIdx for N is 4; the target's ordinal is 2. Keeping the
      // map's number here is what pointed forces at another variable.
      [2, 'INSTANCE0.N'],
    ])
    expect(entries[1].type).toBe('INT_ENUM')
  })

  it('drops a function-block instance, which the target does not list (measured: no TON1)', () => {
    const map = mapOf(
      { path: 'INSTANCE0.START', type: 'BOOL' },
      { path: 'INSTANCE0.TON1.IN', type: 'BOOL' },
      { path: 'INSTANCE0.TON1.PT', type: 'TIME' },
      { path: 'INSTANCE0.TON1.Q', type: 'BOOL' },
      { path: 'INSTANCE0.PREVLED', type: 'BOOL' },
    )
    const entries = projectV3DebugEntries(map, { functionBlockInstances: new Set(['INSTANCE0.TON1']) })

    expect(entries.map((entry) => [entry.index, entry.name])).toEqual([
      [0, 'INSTANCE0.START'],
      [1, 'INSTANCE0.PREVLED'],
    ])
  })

  it('keeps a struct as one entry, because the target lists it (single __DECLARE_VAR)', () => {
    const map = mapOf({ path: 'INSTANCE0.CFG.A', type: 'INT' }, { path: 'INSTANCE0.CFG.B', type: 'INT' })

    expect(projectV3DebugEntries(map).map((entry) => entry.name)).toEqual(['INSTANCE0.CFG'])
  })

  it('returns nothing for a map with no leaves', () => {
    expect(projectV3DebugEntries(mapOf())).toEqual([])
  })
})
