/**
 * The daemon's config hand-off.
 *
 * It carries the runtime password, so it cannot travel in argv, and on Windows
 * it cannot travel on stdin either — an Electron main process does not receive
 * a piped stdin there, which is why every `debug open` used to answer
 * "Malformed daemon config". The file arm is the one that works; stdin stays
 * the fallback for POSIX.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { configFileFrom, readConfig, readConfigFile } from '../daemon-entry'

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/mock/user-data'), exit: jest.fn(), isPackaged: false },
}))

const VALID = {
  registryDir: '/mock/user-data/User/cli-sessions',
  projectPath: '/projects/d2-probe',
  target: 'OpenPLC Runtime v3',
  host: '127.0.0.1',
  port: '',
  username: 'openplc',
  password: 'openplc',
}

describe('daemon config hand-off', () => {
  it('takes the path the parent named, and ignores an empty one', () => {
    expect(configFileFrom({ OPENPLC_CLI_DAEMON_CONFIG: '/tmp/session.config.json' })).toBe('/tmp/session.config.json')
    expect(configFileFrom({ OPENPLC_CLI_DAEMON_CONFIG: '   ' })).toBeUndefined()
    expect(configFileFrom({})).toBeUndefined()
  })

  it('reads the file and removes it — the password does not outlive the read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openplc-daemon-config-'))
    const path = join(dir, 'session.config.json')
    writeFileSync(path, JSON.stringify(VALID), 'utf8')

    expect(readConfigFile(path)).toContain('"password"')
    expect(existsSync(path)).toBe(false)
    // The test's own scratch directory is not the code's to clean, and a suite
    // that leaves one behind per run is a suite that fills a CI runner's /tmp.
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a config that is missing a field the daemon needs', () => {
    expect(readConfig(JSON.stringify(VALID))).toMatchObject({ host: '127.0.0.1', password: 'openplc' })

    const { password: _password, ...withoutPassword } = VALID
    expect(readConfig(JSON.stringify(withoutPassword))).toBeUndefined()
    expect(readConfig('not json')).toBeUndefined()
  })
})
