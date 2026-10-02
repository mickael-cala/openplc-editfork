import { pickExistingPath } from '../pick-existing-path'

describe('pickExistingPath', () => {
  it('takes the first candidate that exists', () => {
    const chosen = pickExistingPath(['/a/preload.js', '/b/preload.js'], (p) => p === '/a/preload.js')

    expect(chosen).toBe('/a/preload.js')
  })

  /**
   * The bug this helper was written for: the built application keeps its files in
   * `dist/main`, and the developer path the old code preferred does not exist
   * unless someone copies the file there by hand.
   */
  it('skips what is missing and returns the later one', () => {
    const chosen = pickExistingPath(
      ['/app/configs/dll/preload.js', '/app/dist/main/preload.js'],
      (p) => p === '/app/dist/main/preload.js',
    )

    expect(chosen).toBe('/app/dist/main/preload.js')
  })

  it('returns null when nothing exists, so the caller can say so', () => {
    expect(pickExistingPath(['/a', '/b'], () => false)).toBeNull()
  })

  it('checks the filesystem when no predicate is given', () => {
    expect(pickExistingPath([__filename])).toBe(__filename)
    expect(pickExistingPath(['/does/not/exist/anywhere'])).toBeNull()
  })
})
