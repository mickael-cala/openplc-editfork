/**
 * Daemon bootstrap: read the config, then serve.
 *
 * The config carries the runtime password, so it never travels in argv — that
 * is readable by any process on the machine via `ps`. It arrives either as a
 * file whose PATH the parent put in `OPENPLC_CLI_DAEMON_CONFIG`, or on stdin.
 *
 * The file is the arm that works on Windows: an Electron main process started
 * there does not receive a piped stdin at all (measured — `process.stdin` just
 * ends, with no data), so the stdin handshake alone made `debug open` answer
 * "Malformed daemon config" on every Windows machine. stdin stays the fallback
 * so POSIX keeps working unchanged.
 */

import { readFileSync, unlinkSync } from 'node:fs'

import { app } from 'electron'

import { type DaemonConfig, runDaemon } from './session/daemon-main'

/** Where the parent left the config, when it passed one by file. */
export function configFileFrom(env: NodeJS.ProcessEnv): string | undefined {
  const path = env.OPENPLC_CLI_DAEMON_CONFIG
  return path !== undefined && path.trim() !== '' ? path : undefined
}

/**
 * Read the config file and remove it: the password lives in it, and it has
 * served its purpose the moment it is in memory.
 */
export function readConfigFile(path: string): string {
  const raw = readFileSync(path, 'utf8')
  try {
    unlinkSync(path)
  } catch {
    // Best effort — the parent also unlinks on child exit.
  }
  return raw
}

export async function runDaemonFromConfig(): Promise<void> {
  const configPath = configFileFrom(process.env)
  const raw = configPath === undefined ? await readFirstLine() : readConfigFile(configPath)
  const config = readConfig(raw)
  if (!config) {
    // Written and awaited before exiting: piped stdout is async, and `app.exit`
    // would drop the line the parent is waiting on.
    await new Promise<void>((resolve) => {
      process.stdout.write(
        `${JSON.stringify({ event: 'failed', code: 'internal', error: 'Malformed daemon config' })}\n`,
        () => resolve(),
      )
    })
    app.exit(1)
    return
  }
  await runDaemon(config)
}

function readFirstLine(): Promise<string> {
  return new Promise((resolve) => {
    let buffered = ''
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString('utf-8')
      const newline = buffered.indexOf('\n')
      if (newline === -1) return
      process.stdin.off('data', onData)
      resolve(buffered.slice(0, newline))
    }
    process.stdin.on('data', onData)
    process.stdin.on('end', () => resolve(buffered))
  })
}

/** Validate the config instead of trusting the hand-off. */
export function readConfig(line: string): DaemonConfig | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record: Record<string, unknown> = { ...parsed }
  const strings = ['registryDir', 'projectPath', 'target', 'host', 'port', 'username', 'password'] as const
  for (const key of strings) {
    if (typeof record[key] !== 'string') return undefined
  }
  return {
    registryDir: String(record.registryDir),
    projectPath: String(record.projectPath),
    target: String(record.target),
    host: String(record.host),
    port: String(record.port),
    username: String(record.username),
    password: String(record.password),
    uploadIfNeeded: record.uploadIfNeeded === true,
    // Finite and non-negative, not merely `number`: `NaN` passed the old check
    // and `setTimeout(NaN)` fires immediately, which would close a session the
    // instant it opened.
    idleTimeoutMs:
      typeof record.idleTimeoutMs === 'number' && Number.isFinite(record.idleTimeoutMs) && record.idleTimeoutMs >= 0
        ? record.idleTimeoutMs
        : 0,
  }
}
