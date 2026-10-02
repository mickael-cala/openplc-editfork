/**
 * D2 probe: do the editor and the target agree on the debug index order?
 *
 * Both sides address a variable by its **position** in a table, and the two
 * tables are built by different programs from the same source:
 *
 *   - the editor sends `<index>` straight from STruC++'s `debug-map.json`
 *     (`arrayIdx`/`elemIdx`, emitted in *declaration order*, one leaf per
 *     member — `docs/strucpp-migration/04-debugger.md`) ;
 *   - the target indexes `core/POUS.h`, which matiec lays out with the program's
 *     private variables first (`tools/plcbuild/plcbuild.lpr`, `BuildDebugTable`).
 *
 * Same count, different order is the dangerous case: the FC 0x41 count check
 * passes and every read/force lands on another variable.
 *
 *   npm run debug:index -- <program.st> [--runtime <openplc-pascal-rewrite>]
 *
 * The `.st` must be the *transpiled* program (what the pipeline sends), not the
 * project's POU file: run `npm run cli -- compile <project> --target "OpenPLC
 * Runtime v3"` and use `build/OpenPLC Runtime v3/src/program.st` when it exists,
 * or wrap the POU in its `CONFIGURATION` block. The editor side of this probe is
 * the pipeline's own STruC++ call, so a mismatch reported here is the editor's.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { runProgramBuildPipeline } from '../src/backend/shared/library/program-build-pipeline'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const stPath = process.argv[2]
if (!stPath || !existsSync(stPath)) {
  console.error('usage: npm run debug:index -- <program.st> [--runtime <path to openplc-pascal-rewrite>]')
  process.exit(2)
}

const source = readFileSync(stPath, 'utf8')
const md5 = createHash('md5').update(source, 'utf8').digest('hex')
const built = runProgramBuildPipeline({ source, md5, pous: [], libraries: [], missingLibraries: [], hasCBlocks: false })

if (!built.success) {
  console.error('STruC++ refused the program; the editor side cannot be measured.')
  for (const error of built.errors) console.error(`  ${error.formatted}`)
  process.exit(1)
}

const mapFile = built.files.find((file) => file.name === 'debug-map.json')
if (!mapFile) {
  console.error('the pipeline produced no debug-map.json')
  process.exit(1)
}

interface Leaf {
  arrayIdx: number
  elemIdx: number
  path: string
  type: string
}
interface DebugMap {
  md5: string
  leaves: Leaf[]
}

const editorMap = JSON.parse(mapFile.content) as DebugMap
/** The last path segment, i.e. the member name: `INSTANCE0.LED` -> `LED`. */
const leafName = (path: string): string => (path.split('.').pop() ?? path).toUpperCase()
const editorOrder = editorMap.leaves.map((leaf) => leafName(leaf.path))

console.log(`editor (STruC++ debug-map.json) — ${editorOrder.length} leaves, md5 ${editorMap.md5}`)
editorMap.leaves.forEach((leaf, index) =>
  console.log(
    `  ${String(index).padStart(2)}  arrayIdx=${leaf.arrayIdx} elemIdx=${leaf.elemIdx}  ${leafName(leaf.path)}  ${leaf.type}`,
  ),
)

const runtime = arg('--runtime')
if (!runtime) {
  console.log('\n(pass --runtime <openplc-pascal-rewrite> to compare with the target table)')
  process.exit(0)
}

const pouHeader = join(runtime, 'core', 'POUS.h')
if (!existsSync(pouHeader)) {
  console.error(`\n${pouHeader} absent — run plcbuild on this same program first.`)
  process.exit(1)
}

// `__DECLARE_VAR(UINT,TICKS)` / `__DECLARE_LOCATED(BOOL,LED)`, in file order.
const targetOrder = [
  ...readFileSync(pouHeader, 'utf8').matchAll(/__DECLARE_(?:VAR|LOCATED)\(\s*[\w\s]+,\s*(\w+)\s*\)/g),
].map((m) => m[1].toUpperCase())

console.log(`\ntarget (core/POUS.h, what plcbuild indexes) — ${targetOrder.length} entries`)
targetOrder.forEach((name, index) => console.log(`  ${String(index).padStart(2)}  ${name}`))

if (editorOrder.length !== targetOrder.length) {
  console.log(
    `\nVERDICT: counts differ (${editorOrder.length} editor / ${targetOrder.length} target) — index addressing is unsafe.`,
  )
  process.exit(1)
}

const firstMismatch = editorOrder.findIndex((name, index) => name !== targetOrder[index])
if (firstMismatch === -1) {
  console.log('\nVERDICT: identical order — by-name read and force address the same variable on both sides.')
  process.exit(0)
}

console.log('\nVERDICT: same count, DIFFERENT order — the counts match while every index points at another variable.')
editorOrder.forEach((name, index) => {
  const target = targetOrder[index]
  console.log(
    `  ${String(index).padStart(2)}  editor=${name.padEnd(12)} target=${target}${name === target ? '' : '   <-- MISMATCH'}`,
  )
})
process.exit(1)
