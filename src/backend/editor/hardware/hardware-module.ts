import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve as pathResolve, sep as pathSep } from 'node:path'
import { promisify } from 'node:util'

import { app as electronApp } from 'electron'
import { produce } from 'immer'
import { SerialPort as NodeSerialPort } from 'serialport'

import { readHalsFile } from '../../shared/firmware/hals-loader'
import { type BoardBuildInfo, BoardInfoResolver } from '../../shared/hardware/board-info-resolver'
import { PackageManagerModule } from '../package-manager'
import { logger } from '../services/logger-service'
import { assertPathContained } from '../utils/path-containment'
import { orderBoardsByVppGroup } from './order-boards-by-vpp-group'
import { mergeSerialPortList, toCalloutPath } from './serial-port-list'
import type { AvailableBoards, HalsFile, SerialPort } from './types'

const execFileAsync = promisify(execFile)

// interface MethodsResult<T> {
//   success: boolean
//   data?: T
// }

class HardwareModule {
  binaryDirectoryPath: string
  sourcesDirectoryPath: string

  arduinoCliBinaryPath: string
  arduinoCliConfigurationFilePath: string
  arduinoCliBaseParameters: string[]
  arduinoCoreFilePath: string

  // ############################################################################
  // =========================== Static properties ==============================
  // ############################################################################
  static readonly HOST_PLATFORM = process.platform
  static readonly HOST_ARCHITECTURE = process.arch
  /** Unpackaged means the binaries and sources sit beside the checkout. See the
   *  note on `CompilerModule.DEVELOPMENT_MODE` for why this is not `NODE_ENV`. */
  static readonly DEVELOPMENT_MODE = !electronApp.isPackaged

  constructor() {
    this.binaryDirectoryPath = this.#constructBinaryDirectoryPath()
    this.sourcesDirectoryPath = this.#constructSourceDirectoryPath()

    this.arduinoCliBinaryPath = this.#constructArduinoCliBinaryPath()
    this.arduinoCliConfigurationFilePath = join(electronApp.getPath('userData'), 'User', 'arduino-cli.yaml')
    // INFO: We use this approach because some commands can receive additional parameters as a string array.
    this.arduinoCliBaseParameters = ['--config-file', this.arduinoCliConfigurationFilePath]
    this.arduinoCoreFilePath = this.#constructArduinoCoreFilePath()
  }

  // ############################################################################
  // =========================== Static methods =================================
  // ############################################################################

  static async readJSONFile<T>(filePath: string): Promise<T> {
    const data = await readFile(filePath, 'utf-8')
    return JSON.parse(data) as T
  }

  // ############################################################################
  // =========================== Private methods ================================
  // ############################################################################

  // Initialize paths based on the environment
  #constructBinaryDirectoryPath(): string {
    if (HardwareModule.HOST_ARCHITECTURE !== 'x64' && HardwareModule.HOST_ARCHITECTURE !== 'arm64') return ''
    const platformSpecificPath = join(HardwareModule.HOST_PLATFORM, HardwareModule.HOST_ARCHITECTURE)
    return join(
      HardwareModule.DEVELOPMENT_MODE ? process.cwd() : process.resourcesPath,
      HardwareModule.DEVELOPMENT_MODE ? 'resources' : '',
      'bin',
      HardwareModule.DEVELOPMENT_MODE ? platformSpecificPath : '',
    )
  }

  #constructSourceDirectoryPath(): string {
    return join(
      HardwareModule.DEVELOPMENT_MODE ? process.cwd() : process.resourcesPath,
      HardwareModule.DEVELOPMENT_MODE ? 'resources' : '',
      'sources',
    )
  }

  // TODO: Validate the path.
  #constructArduinoCliBinaryPath(): string {
    return join(this.binaryDirectoryPath, 'arduino-cli')
  }

  #constructArduinoCoreFilePath(): string {
    return join(electronApp.getPath('userData'), 'User', 'Runtime', 'arduino-core-control.json')
  }

  // ############################################################################
  // =========================== Public methods =================================
  // ############################################################################

  // ++ ============================= Getters ================================ ++
  async getAvailableSerialPorts(): Promise<SerialPort[]> {
    // Two independent, best-effort scans merged by device path. The path is
    // always the primary, unique label (mirrors the Arduino IDE); the
    // parenthetical descriptor is the arduino-cli-identified board name when
    // known, falling back to `serialport`'s manufacturer/vendor string. See
    // `mergeSerialPortList` for the labelling rules. Running both scans is
    // cheap here: the list is static after build and only re-scanned on an
    // explicit user refresh.
    const [boardNamesByPath, manufacturersByPath] = await Promise.all([
      this.#identifyBoardsByPath(),
      this.#listSerialPortManufacturers(),
    ])
    return mergeSerialPortList(boardNamesByPath, manufacturersByPath)
  }

  /**
   * Is this serial port still attached?
   *
   * The `serialport` scan only — deliberately NOT `getAvailableSerialPorts()`,
   * which also shells out to arduino-cli. This is called on every tick of the
   * device link poll to tell a pulled USB cable (fail now, there is nothing to
   * retry against) from a device that is merely slow to answer (retry), so it has
   * to be instant.
   *
   * Fails SAFE: if enumeration itself breaks, the port is reported present. A
   * false "gone" would tear down a working connection, which is worse than
   * waiting out one timeout.
   */
  async isSerialPortPresent(address: string): Promise<boolean> {
    try {
      const ports = await NodeSerialPort.list()
      const wanted = toCalloutPath(address)
      return ports.some((port) => toCalloutPath(port.path) === wanted)
    } catch (error: unknown) {
      logger.error(`Failed to check serial port presence: ${String(error)}`)
      return true
    }
  }

  /**
   * `serialport` enumeration → `path → manufacturer`. This is the reliable,
   * instant, cross-platform source for the *set* of ports; arduino-cli only
   * enriches it. Best-effort: any failure yields an empty map (never throws)
   * so arduino-cli-discovered ports still come through.
   */
  async #listSerialPortManufacturers(): Promise<Map<string, string | undefined>> {
    try {
      const ports = await NodeSerialPort.list()
      return new Map(ports.map((port) => [port.path, port.manufacturer]))
    } catch (error: unknown) {
      logger.error(`Failed to enumerate serial ports: ${String(error)}`)
      return new Map()
    }
  }

  /**
   * `arduino-cli board list --format json` → `path → board name`. arduino-cli
   * matches each port's USB VID/PID against the installed cores' `boards.txt`
   * — the exact identification the Arduino IDE surfaces (e.g. `Arduino Uno`,
   * `Opta`). A detected-but-unmatched port maps to `undefined` (it will fall
   * back to the manufacturer descriptor). Best-effort: a missing binary, no
   * installed cores, a spawn error, or malformed JSON all yield an empty map
   * so plain `serialport` enumeration still works. Reuses the same binary and
   * `--config-file` as compile/upload, so it sees the same installed cores.
   */
  async #identifyBoardsByPath(): Promise<Map<string, string | undefined>> {
    const boardNamesByPath = new Map<string, string | undefined>()
    try {
      let binaryPath = this.arduinoCliBinaryPath
      if (HardwareModule.HOST_PLATFORM === 'win32') binaryPath += '.exe'

      const { stdout } = await execFileAsync(
        binaryPath,
        ['board', 'list', '--format', 'json', ...this.arduinoCliBaseParameters],
        { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
      )

      const parsed = JSON.parse(stdout) as {
        detected_ports?: Array<{
          matching_boards?: Array<{ name?: string }>
          port?: { address?: string }
        }>
      }

      for (const detected of parsed.detected_ports ?? []) {
        const address = detected.port?.address
        if (!address) continue
        boardNamesByPath.set(address, detected.matching_boards?.[0]?.name)
      }
    } catch (error: unknown) {
      logger.warn(`arduino-cli board list failed; serial ports will show without board names: ${String(error)}`)
    }
    return boardNamesByPath
  }

  /**
   * Resolve compile/upload info for `boardName` from either hals.json or
   * an installed VPP package. Compiler module should call this instead
   * of reading hals.json directly.
   */
  async getBoardBuildInfo(boardName: string): Promise<BoardBuildInfo> {
    const halsContent = await readHalsFile<HalsFile>()
    const resolver = new BoardInfoResolver({
      halsContent,
      packageManager: new PackageManagerModule(),
      // Editor maps hals.json `source` (relative HAL .cpp filename) to
      // an absolute path under `resources/sources/hal/`.  Web's adapter
      // (when VPP-on-web lands) will map the same string to a bundled-
      // asset key.
      resolveHalSourcePath: (rel) => join(this.sourcesDirectoryPath, 'hal', rel),
      // Editor security-check: VPP-package-relative paths must resolve
      // inside the package's root directory.  Web's adapter will pick
      // its own scheme when VPP-on-web lands.
      resolvePackageRelativePath: (pkgPath, relPath) => {
        const root = pathResolve(pkgPath)
        const candidate = pathResolve(root, relPath)
        if (candidate !== root && !candidate.startsWith(root + pathSep)) {
          throw new Error(`Path "${relPath}" escapes package directory ${pkgPath}`)
        }
        return candidate
      },
    })
    return resolver.resolve(boardName)
  }

  async getAvailableBoards(): Promise<AvailableBoards> {
    // hals.json is now bundled at `src/backend/shared/firmware/hals.json`
    // (the canonical shared board catalogue editor and web both consume).
    // `readHalsFile` resolves synchronously off the bundled JSON — keeps
    // the async shape so this call site stays unchanged.
    const halsFileContent = await readHalsFile<HalsFile>()
    const arduinoCoreFileContent = await HardwareModule.readJSONFile<{ [core: string]: string }[]>(
      this.arduinoCoreFilePath,
    )

    // Create a Map to store the available boards, which will be returned
    let availableBoards: AvailableBoards = new Map()

    for (const [board, boardData] of Object.entries(halsFileContent)) {
      const coreVersion = arduinoCoreFileContent.find((core) => Object.keys(core)[0] === boardData.core)?.[
        boardData.core
      ]

      availableBoards = produce(availableBoards, (draft) => {
        draft.set(board, {
          compiler: boardData.compiler,
          core: boardData.core,
          ...(boardData.platform ? { platform: boardData.platform } : {}),
          preview: boardData.preview,
          specs: boardData.specs,
          coreVersion: coreVersion ?? undefined,
          pins: {
            defaultAin:
              boardData.default_ain
                ?.split(',')
                .map((pin) => pin.trim())
                .filter(Boolean) ?? [],
            defaultAout:
              boardData.default_aout
                ?.split(',')
                .map((pin) => pin.trim())
                .filter(Boolean) ?? [],
            defaultDin:
              boardData.default_din
                ?.split(',')
                .map((pin) => pin.trim())
                .filter(Boolean) ?? [],
            defaultDout:
              boardData.default_dout
                ?.split(',')
                .map((pin) => pin.trim())
                .filter(Boolean) ?? [],
          },
          ...(boardData.debug ? { debug: boardData.debug } : {}),
          // The capability block next to it is not decoration:
          // `resolveTargetCapabilities` reads `debuggerTransports` from here.
          // Dropping it left every built-in target on the Runtime v4 profile
          // (`websocket`), so Runtime v3's only channel — Modbus TCP — was
          // discarded and the resolver described no debug link at all
          // (ERR-062). The VPP path below copies it for the same reason.
          ...(boardData.capabilities ? { capabilities: boardData.capabilities } : {}),
        })
      })
    }
    // ONE target, by construction: this fork serves OpenPLC Runtime v3
    // (docs/STELLARIA-V3.md), so the catalogue `hals.json` is the whole board
    // list. Installed `.vpp` packages are no longer merged into it — they were
    // also the last way a project could still reach the Runtime v4 pipeline or
    // the Arduino firmware chain this fork has removed.
    //
    // The ordering helper stays: it pins the built-in targets to the top of the
    // device dropdown, which still matters with a list of one.
    return orderBoardsByVppGroup(new Map(availableBoards))
  }

  async getBoardImagePreview(image: string, packagePath?: string) {
    // `image` arrives from a board manifest (built-in or VPP-installed)
    // and ultimately from disk-resident JSON the user can edit. Without
    // containment, an entry like `image: "../../../../etc/passwd"`
    // would resolve outside the expected directory and the contents
    // would be base64'd back across the IPC boundary — effectively a
    // file-read primitive scoped to whatever the editor user can read.
    //
    // For built-in boards: contain under sources/boards/previews.
    // For VPP boards: contain under the package's own directory, since
    // package authors expect to ship their preview alongside other
    // package assets.
    const baseDir = packagePath ? packagePath : join(this.sourcesDirectoryPath, 'boards', 'previews')
    const imagePath = join(baseDir, image)
    assertPathContained(baseDir, imagePath, 'preview image path')

    const imageBuffer = await readFile(imagePath)

    const base64Image = imageBuffer.toString('base64')

    return `data:image/png;base64,${base64Image}`
  }

  async getDeviceConfigurationOptions() {
    const [communicationPorts, availableBoards] = await Promise.allSettled([
      this.getAvailableSerialPorts(),
      this.getAvailableBoards(),
    ])
    return { ports: communicationPorts, boards: availableBoards }
  }
}

export { HardwareModule }
