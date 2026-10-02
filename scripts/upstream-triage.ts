/**
 * Which upstream (`Autonomy-Logic/openplc-editor`) commits are worth reading?
 *
 * Stellaria forked at 4.3.2 and gave up the shared-surface mirror contract, so
 * upstream is now a SOURCE OF IDEAS rather than a branch to stay equal with: the
 * generalist work (UI, graphic editors, Monaco, i18n, tests, performance) is a
 * candidate to cherry-pick; the PLC evolution (Runtime v4 / STruC++, Arduino,
 * in-process simulator, VPP) is what this fork removed, and the cloud/AI
 * surfaces are what J1 cut. See `docs/STELLARIA-VISION.md` § 4.
 *
 *   npm run upstream:triage              # everything after the marker
 *   npm run upstream:triage -- --mark    # ... and move the marker to the tip
 *   npm run upstream:triage -- --since v4.3.2 --branch upstream/main
 *
 * The marker file `.upstream-reviewed` holds the newest upstream commit already
 * triaged; without it (fresh clone) the range starts at the fork point.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const MARKER = join(ROOT, '.upstream-reviewed')
/**
 * Upstream lands its work on `development` and only pushes `main` at release
 * time — `HEAD..upstream/main` is empty between releases, so watching `main`
 * would report "nothing new" for weeks. Our fork's base is the 4.3.2 release
 * branch (`d272dde51` is an ancestor of HEAD; the main-side merge is not).
 */
const DEFAULT_BRANCH = 'upstream/development'

/** What this fork removed: a commit touching these is not ours to take. */
const REMOVED_PATHS = [
  'src/backend/shared/compile/',
  'src/backend/shared/firmware/',
  'src/backend/editor/runtime/',
  'src/backend/shared/simulator/',
  'src/backend/editor/package-manager/',
  'src/backend/shared/utils/vpp/',
  'src/middleware/shared/utils/library/',
  'resources/sources/',
  'resources/bin/',
]

/**
 * Cloud/AI surfaces J1 cut. Kept as a SUBJECT heuristic as well as a path one:
 * the work lives in files named after the product ("edit session", "partner",
 * "cloud working copy") far more reliably than under a single directory.
 */
const CUT_PATHS = ['src/backend/editor/edge-', 'src/backend/editor/ai', 'src/frontend/services/edge']
const CUT_SUBJECT = /\b(cloud|edge|ai|partner|telemetry|edit session)\b/i

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const branch = arg('--branch') ?? DEFAULT_BRANCH
const mark = process.argv.includes('--mark')
const since =
  arg('--since') ??
  (existsSync(MARKER) ? readFileSync(MARKER, 'utf8').trim() : git(['merge-base', 'HEAD', branch]).trim())

let raw: string
try {
  raw = git(['log', `--format=%h%x09%s`, '--name-only', '--no-merges', `${since}..${branch}`])
} catch {
  console.error(
    `Cannot read ${branch}. Run: git remote add upstream https://github.com/Autonomy-Logic/openplc-editor && git fetch upstream`,
  )
  process.exit(2)
}

interface Commit {
  sha: string
  subject: string
  paths: string[]
}

// Line-based rather than blank-line-based: `git log` separates entries with an
// empty line, and on Windows those lines end CRLF, so splitting on '\n\n' finds
// no separator at all and swallows every commit into the first one.
const commits: Commit[] = []
for (const line of raw.split(/\r?\n/)) {
  if (line.includes('\t')) {
    const [sha, subject] = line.split('\t')
    commits.push({ sha, subject, paths: [] })
    continue
  }
  if (line.trim() && commits.length > 0) commits[commits.length - 1].paths.push(line.trim())
}

const isRemoved = (c: Commit) => c.paths.some((p) => REMOVED_PATHS.some((prefix) => p.startsWith(prefix)))
const isCut = (c: Commit) =>
  !isRemoved(c) &&
  (c.paths.some((p) => CUT_PATHS.some((prefix) => p.startsWith(prefix))) || CUT_SUBJECT.test(c.subject))

const buckets = [
  { title: 'PLC / cible — retiré chez nous, on ne prend pas', commits: commits.filter(isRemoved) },
  { title: 'Cloud / IA — coupé en J1, on ne prend pas', commits: commits.filter(isCut) },
  { title: 'Généraliste — candidat à un cherry-pick', commits: commits.filter((c) => !isRemoved(c) && !isCut(c)) },
]

console.log(`upstream: ${branch}   range: ${since}..${branch}   commits: ${commits.length}`)
for (const bucket of buckets) {
  console.log(`\n${bucket.title}  (${bucket.commits.length})`)
  for (const commit of bucket.commits) console.log(`  ${commit.sha}  ${commit.subject}`)
}

const candidates = buckets[2].commits
console.log(
  `\nPrendre un commit : git cherry-pick -x <sha>  (le -x garde la trace du sha amont).\n` +
    `Un commit qui dépend d'un sous-système retiré se reprend comme IDÉE, pas comme patch.\n` +
    `${candidates.length} candidat(s) sur ${commits.length}.`,
)

if (mark) {
  const tip = git(['rev-parse', branch]).trim()
  writeFileSync(MARKER, `${tip}\n`, 'utf8')
  console.log(`\nMarqueur déplacé : ${MARKER} -> ${tip}`)
}
