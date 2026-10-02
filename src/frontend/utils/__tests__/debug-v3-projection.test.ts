/**
 * The v3 projection is measured against the target's own table: the expected
 * lists below are what `tools/plcbuild/plcbuild.exe` writes into
 * `core/POUS.h` for the same programs (D2/J4.0 in
 * `docs/STELLARIA-V3-ROADMAP.md`).
 */
import type { SystemLibrary } from '../../../middleware/shared/ports/library-types'
import type { PLCInstance, PLCPou } from '../../../middleware/shared/ports/types'
import type { DebugMap } from '../debug-parser'
import { declarationPathOf, functionBlockInstancePaths, projectV3DebugEntries } from '../debug-v3-projection'

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

describe('functionBlockInstancePaths', () => {
  const tonLibrary: SystemLibrary = {
    name: 'standard',
    pous: [{ name: 'TON', type: 'function-block', variables: [] }],
  } as unknown as SystemLibrary

  const program = (variables: Array<{ name: string; definition: string; value: string; class?: string }>): PLCPou =>
    ({
      name: 'prog0',
      pouType: 'program',
      interface: {
        variables: variables.map((v) => ({
          name: v.name,
          class: v.class ?? 'local',
          type: { definition: v.definition, value: v.value },
        })),
      },
    }) as unknown as PLCPou

  const instances: PLCInstance[] = [{ name: 'instance0', program: 'prog0', task: 'task0' }]

  it('names the FB instances of a program, uppercased like the map paths', () => {
    const pous = [
      program([
        { name: 'start', definition: 'base-type', value: 'BOOL' },
        { name: 'ton1', definition: 'user-data-type', value: 'TON' },
        { name: 'arr', definition: 'array', value: 'ARRAY' },
      ]),
    ]

    expect([...functionBlockInstancePaths(pous, instances, [tonLibrary])]).toEqual(['INSTANCE0.TON1'])
  })

  it('leaves a struct in place, because the target lists it', () => {
    const pous = [
      program([
        { name: 'cfg', definition: 'user-data-type', value: 'MY_STRUCT' },
        { name: 'ton1', definition: 'user-data-type', value: 'TON' },
      ]),
    ]

    expect([...functionBlockInstancePaths(pous, instances, [tonLibrary])]).toEqual(['INSTANCE0.TON1'])
  })

  it('ignores a program with no instance, and externals', () => {
    const pous = [
      program([
        { name: 'shared', definition: 'user-data-type', value: 'TON', class: 'external' },
        { name: 'ton1', definition: 'user-data-type', value: 'TON' },
      ]),
    ]

    expect([...functionBlockInstancePaths(pous, [], [tonLibrary])]).toEqual([])
    expect([...functionBlockInstancePaths(pous, [{ name: 'other', program: 'absent', task: 't' }], [tonLibrary])]).toEqual(
      [],
    )
    expect([...functionBlockInstancePaths(pous, instances, [tonLibrary])]).toEqual(['INSTANCE0.TON1'])
  })
})
