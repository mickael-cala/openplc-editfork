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
import type { SystemLibrary } from '../../middleware/shared/ports/library-types'
import type { PLCInstance, PLCPou } from '../../middleware/shared/ports/types'
import type { DebugMap, DebugVariableEntry } from './debug-parser'
import { isFunctionBlockType, normalizeTypeString } from './pou-helpers'

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

/** One declaration of the target's table, with what a decoder needs. */
export interface V3Declaration {
  /** `INSTANCE0.ARR` — the path the map declares, at declaration granularity. */
  declaration: string
  /** The ordinal the target indexes this declaration by. */
  index: number
  /** Its type, as `debug-map.json` spells it (no `_ENUM` suffix). */
  type: string
  /** Width in bytes: the declaration's first leaf's size (an array's element
   *  size — the target addresses the whole array, and this is the best the map
   *  offers for it). */
  size: number
}

/**
 * The declarations a v3 target lists, in its order, with their ordinals.
 *
 * `projectV3DebugEntries` is this plus the `_ENUM` type suffix the debug tree
 * expects; the CLI needs the raw type and the size to decode a reply.
 */
export function projectV3Declarations(map: DebugMap, options: V3ProjectionOptions = {}): V3Declaration[] {
  const fbInstances = options.functionBlockInstances ?? new Set<string>()
  const declarations: V3Declaration[] = []
  const seen = new Set<string>()

  for (const leaf of map.leaves) {
    const declaration = declarationPathOf(leaf.path)
    if (seen.has(declaration) || fbInstances.has(declaration)) continue
    seen.add(declaration)

    declarations.push({
      declaration,
      // The target's index is the ordinal of the declaration in its table.
      index: declarations.length,
      type: leaf.type,
      size: leaf.size,
    })
  }

  return declarations
}

/**
 * One entry per declaration the target lists, in declaration order, with the
 * ordinal as its index. Returns `[]` for a map with no leaves.
 */
export function projectV3DebugEntries(map: DebugMap, options: V3ProjectionOptions = {}): DebugVariableEntry[] {
  return projectV3Declarations(map, options).map((entry) => ({
    name: entry.declaration,
    type: `${entry.type}_ENUM`,
    index: entry.index,
  }))
}

/**
 * Declaration paths (`INSTANCE0.TON1`) of every function-block instance the
 * project instantiates — the declarations the target's table omits.
 *
 * The FB test is `isFunctionBlockType`, the same predicate the debug tree uses
 * (`debug-tree-traversal.ts`), so the projection and the tree agree on what is
 * an FB and what is a STRUCT — and a STRUCT, which the target *does* list as one
 * `__DECLARE_VAR` entry, must stay in the projection.
 */
export function functionBlockInstancePaths(
  pous: PLCPou[],
  instances: PLCInstance[],
  systemLibraries: SystemLibrary[],
): Set<string> {
  const paths = new Set<string>()

  for (const instance of instances) {
    const program = pous.find(
      (pou) =>
        normalizeTypeString(pou.pouType) === 'program' && pou.name.toUpperCase() === instance.program.toUpperCase(),
    )
    if (!program) continue

    for (const variable of program.interface?.variables ?? []) {
      // Externals live in the shared globals, not in the instance's struct.
      if (variable.class === 'external') continue
      if (variable.type.definition === 'base-type' || variable.type.definition === 'array') continue
      if (!isFunctionBlockType(variable.type.value, pous, systemLibraries)) continue

      paths.add(`${instance.name}.${variable.name}`.toUpperCase())
    }
  }

  return paths
}

/**
 * The composite key the editor's UI uses for a declaration of an instance —
 * `INSTANCE0.LED` plus the project gives `main:led`, in the casing the tree
 * declares it. The store keys are minted by the tree, so anything that wants
 * to be looked up by `use-debug-value` must match that casing exactly.
 */
export function declarationCompositeKey(
  declaration: string,
  pous: PLCPou[],
  instances: PLCInstance[],
): string | undefined {
  const [instanceName, ...members] = declaration.split('.')
  const instance = instances.find((candidate) => candidate.name.toUpperCase() === instanceName.toUpperCase())
  if (!instance || members.length !== 1) return undefined
  const program = pous.find(
    (pou) =>
      normalizeTypeString(pou.pouType) === 'program' && pou.name.toUpperCase() === instance.program.toUpperCase(),
  )
  if (!program) return undefined
  const variable = program.interface?.variables.find(
    (candidate) => candidate.name.toUpperCase() === members[0].toUpperCase(),
  )
  if (!variable) return undefined
  return `${program.name}:${variable.name}`
}

/** What the backend's registry contributes to the forced-variables map. */
export interface ExternalForcesState {
  /** The store's next `debugForcedVariables`. */
  forced: Map<string, boolean>
  /** The keys THIS registry put there, so the next refresh can retire them. */
  external: Set<string>
}

/**
 * Apply the BACKEND's force registry (WS-109) on top of the editor's own forces.
 *
 * `current` is the store's `debugForcedVariables`; `previousExternal` is what
 * the LAST refresh contributed; `forces` is the registry as it stands now;
 * `indexToKey` maps the target's ordinals to the composite keys the tree uses.
 *
 * A refresh has to do both halves, which is the whole point of tracking
 * `previousExternal`: a force released from the web interface disappears from
 * the registry, and the mark we added for it must go with it — while a force the
 * EDITOR made never came from the registry and must survive, because the editor
 * forces the target directly and the backend never hears about it.
 *
 * An index with no key (a composite the editor cannot address, or a registry
 * from a different program) is dropped rather than guessed at.
 */
export function applyExternalForces(
  current: ReadonlyMap<string, boolean>,
  previousExternal: ReadonlySet<string>,
  forces: ReadonlyArray<{ index: number; type: string; value: string }>,
  indexToKey: ReadonlyMap<number, string>,
): ExternalForcesState {
  const forced = new Map(current)
  for (const key of previousExternal) forced.delete(key)

  const external = new Set<string>()
  for (const force of forces) {
    const key = indexToKey.get(force.index)
    if (key === undefined) continue
    forced.set(key, true)
    external.add(key)
  }

  return { forced, external }
}

/**
 * Whether two forced-variable maps say the same thing.
 *
 * The registry refresh runs on a timer, and `setDebugForcedVariables` is one of
 * the values the polling loop watches to invalidate its "what should I read
 * next" cache — a cache the poller explicitly expects to change on user action,
 * not on a clock. Writing a fresh, equal Map every couple of seconds therefore
 * made the poller rebuild that set continuously and the displayed values
 * stopped following the target. Only a real change may be published.
 */
export function areForcedMapsEqual(a: ReadonlyMap<string, boolean>, b: ReadonlyMap<string, boolean>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false
  }
  return true
}
