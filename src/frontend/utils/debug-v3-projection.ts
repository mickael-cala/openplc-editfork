/**
 * Project a debug map onto the table a **Runtime v3 target** actually indexes.
 *
 * The editor addresses a variable by a position taken from STruC++'s
 * `debug-map.json`, and that map is finer-grained than the target's table:
 *
 *   editor (STruC++)        target (plcbuild, from `core/POUS.h`)
 *   LED, ARR[0..2], N       LED, ARR, N          <- one entry per declaration
 *   TON1.Q, TON1.ET, ...    (no `TON1` entry at all: an FB instance is a plain
 *                            `TON TON1;` field, and `ExtraireVariablesPou`
 *                            only reads the `__DECLARE_VAR` / `__DECLARE_LOCATED`
 *                            lines, in file order)
 *
 * So a project with an array or an FB instance made the two counts differ, the
 * FC 0x41 check refused the session, and by-name debugging was unavailable for
 * any such project (measured: `docs/STELLARIA-V3-ROADMAP.md`, D2/J4.0).
 *
 * This projection mirrors the target's rule: declarations in order, one entry
 * each (composites opaque), FB instances dropped, and the **index is the
 * ordinal** — not STruC++'s `elemIdx`, which no longer describes this table.
 *
 * Which declarations are FB instances cannot be read off the map (a STRUCT
 * variable has fields too, and the target *does* list it as one entry), so the
 * caller supplies them from the project's variable table.
 */
import type { DebugMap, DebugVariableEntry } from './debug-parser'

/**
 * The declaration a leaf belongs to: `INSTANCE0.ARR[2]` and
 * `INSTANCE0.ARR[0].FIELD` both give `INSTANCE0.ARR`, `INSTANCE0.FB1.Q` gives
 * `INSTANCE0.FB1`, and an unprefixed leaf is its own declaration.
 */
export function declarationPathOf(leafPath: string): string {
  const withoutArray = leafPath.split('[')[0]
  const parts = withoutArray.split('.')
  // Instance prefix + one member; anything deeper is a field of that member.
  return parts.slice(0, Math.min(2, parts.length)).join('.')
}

export interface V3ProjectionOptions {
  /**
   * Declaration paths (`INSTANCE0.TON1`) of the project's function-block
   * instances — the ones the target's table omits.
   */
  functionBlockInstances?: ReadonlySet<string>
}

/**
 * One entry per declaration the target lists, in declaration order, with the
 * ordinal as its index. Returns `[]` for a map with no leaves.
 */
export function projectV3DebugEntries(map: DebugMap, options: V3ProjectionOptions = {}): DebugVariableEntry[] {
  const fbInstances = options.functionBlockInstances ?? new Set<string>()
  const entries: DebugVariableEntry[] = []
  const seen = new Set<string>()

  for (const leaf of map.leaves) {
    const declaration = declarationPathOf(leaf.path)
    if (seen.has(declaration) || fbInstances.has(declaration)) continue
    seen.add(declaration)

    entries.push({
      name: declaration,
      type: `${leaf.type}_ENUM`,
      // The target's index is the ordinal of the declaration in its table.
      index: entries.length,
    })
  }

  return entries
}
