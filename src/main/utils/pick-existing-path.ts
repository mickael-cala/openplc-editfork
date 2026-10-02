import { existsSync } from 'node:fs'

/**
 * Return the first of `candidates` that exists, or `null` when none does.
 *
 * The built application ships its own files next to the compiled main entry
 * (`dist/main/preload.js`, `dist/main/splash.html`), and so does the packaged
 * one. The original code asked `app.isPackaged` WHICH location to use, which sent
 * a built-but-unpackaged launch — this repository's own way of running the app,
 * and what the e2e harness does — to a developer path the build never writes.
 * The window then rendered blank because its preload was missing, and the only
 * clue was an error about `onSimulatorStopped` in the renderer console.
 *
 * Asking which file is really there, instead of inferring it from packaging,
 * removes the whole class: packaged, unpackaged and source launches each find the
 * file that exists. `exists` is injectable so the choice is testable without a
 * filesystem, and the caller logs what won.
 */
export function pickExistingPath(
  candidates: readonly string[],
  exists: (candidate: string) => boolean = existsSync,
): string | null {
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return null
}
