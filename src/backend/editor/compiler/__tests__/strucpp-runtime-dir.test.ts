/**
 * The debug compile used to answer "STruC++ runtime headers not found" whenever
 * the app was started with anything other than the repo root as its app path —
 * `electron release/app`, or the CLI's bundle under `release/app/dist/main`.
 * These tests pin the resolution rule: walk up from every plausible root.
 */
import { dirname, join, sep } from 'node:path'

import { pickStrucppRuntimeDir, strucppRuntimeDirCandidates } from '../strucpp-runtime-dir'

const includeOf = (root: string): string => join(root, 'node_modules', 'strucpp', 'src', 'runtime', 'include')

describe('strucppRuntimeDirCandidates', () => {
  it('walks up from each start directory, nearest first', () => {
    const appPath = join(sep, 'repo', 'release', 'app', 'dist', 'main')
    const cwd = join(sep, 'repo')

    const candidates = strucppRuntimeDirCandidates([appPath, cwd], 3)

    expect(candidates[0]).toBe(includeOf(appPath))
    expect(candidates[1]).toBe(includeOf(dirname(appPath)))
    // `.../repo/node_modules/...` is reached from BOTH roots, and appears once.
    expect(candidates).toContain(includeOf(cwd))
    expect(candidates.filter((candidate) => candidate === includeOf(cwd))).toHaveLength(1)
  })

  it('ignores an empty start directory and stops at the filesystem root', () => {
    expect(strucppRuntimeDirCandidates([''], 3)).toEqual([])

    const candidates = strucppRuntimeDirCandidates([join(sep, 'repo')], 10)
    expect(candidates[candidates.length - 1]).toBe(includeOf(sep))
  })
})

describe('pickStrucppRuntimeDir', () => {
  it('returns the first candidate that exists', () => {
    const present = includeOf(join(sep, 'repo'))
    const candidates = [includeOf(join(sep, 'repo', 'release', 'app', 'dist', 'main')), present]

    expect(pickStrucppRuntimeDir(candidates, (path) => path === present)).toBe(present)
  })

  it('answers undefined when nothing exists, so the caller can report its own paths', () => {
    expect(pickStrucppRuntimeDir(['/nope/a', '/nope/b'], () => false)).toBeUndefined()
  })
})
