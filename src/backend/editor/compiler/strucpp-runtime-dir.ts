/**
 * Where to find STruC++'s runtime headers (`src/runtime/include/`).
 *
 * In an UNPACKAGED run the headers live in the root install —
 * `node_modules/strucpp/src/runtime/include`, which `npm run setup:strucpp`
 * populates from the pinned release tarball. Which directory that install sits
 * under depends on how the app was started, and the app is started in more than
 * one way:
 *
 *   - `npm run dev` runs `electron .` from the repo root, so `getAppPath()` IS
 *     the repo root and `getAppPath()/node_modules/strucpp/...` resolves;
 *   - handing Electron the unpackaged app directory (`electron release/app`)
 *     makes `getAppPath()` that directory, and the CLI's own bundle is handed
 *     `release/app/dist/main/main.js`, whose directory is what Electron reports
 *     there — neither has `node_modules/strucpp` below it, so the single
 *     formula the compiler used answered "headers not found" and every debug
 *     compile failed with the editor looking perfectly healthy otherwise.
 *
 * Resolving like Node does — walk up from each plausible root — covers all of
 * them without the compiler having to know how it was launched.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** How many parent levels to walk before giving up on a start directory. */
const DEFAULT_MAX_PARENTS = 5

/**
 * `startDir/node_modules/strucpp/src/runtime/include`, then the same under each
 * parent, for every start directory, in order.
 */
export function strucppRuntimeDirCandidates(
  startDirs: readonly string[],
  maxParents: number = DEFAULT_MAX_PARENTS,
): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()

  for (const start of startDirs) {
    if (!start) continue
    let directory = start
    for (let level = 0; level <= maxParents; level += 1) {
      const candidate = join(directory, 'node_modules', 'strucpp', 'src', 'runtime', 'include')
      if (!seen.has(candidate)) {
        seen.add(candidate)
        candidates.push(candidate)
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }

  return candidates
}

/** The first candidate that exists, or `undefined` when none does. */
export function pickStrucppRuntimeDir(
  candidates: readonly string[],
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  return candidates.find((candidate) => exists(candidate))
}
