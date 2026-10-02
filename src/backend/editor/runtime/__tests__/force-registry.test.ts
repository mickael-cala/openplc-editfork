/**
 * `GET /api/force` (WS-109) — the only source of truth for a force made from
 * the web interface, since the runtime never reports who forced a variable.
 *
 * Driven through the same mocked `https` as the response-limit tests: the
 * interesting behaviour here is what the client accepts and returns, not the
 * transport.
 */
import { EventEmitter } from 'events'

const requestMock = jest.fn()
jest.mock('https', () => ({ request: (...args: unknown[]) => requestMock(...args) }))

import { ForceRegistrySchema, RuntimeApiClient } from '../runtime-api-client'

function mockResponse(chunks: string[]) {
  const req = Object.assign(new EventEmitter(), {
    setTimeout: jest.fn(),
    end: jest.fn(),
    write: jest.fn(),
  })
  requestMock.mockImplementation((_options: unknown, handler: (res: EventEmitter) => void) => {
    const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} })
    setImmediate(() => {
      handler(res)
      for (const chunk of chunks) res.emit('data', Buffer.from(chunk))
      res.emit('end')
    })
    return req
  })
}

async function loggedInClient(): Promise<RuntimeApiClient> {
  const client = new RuntimeApiClient()
  mockResponse(['{"access_token":"test-token"}'])
  const login = await client.login('192.168.1.50', 'openplc', 'openplc')
  expect(login.success).toBe(true)
  return client
}

beforeEach(() => {
  requestMock.mockReset()
})

describe('ForceRegistrySchema', () => {
  it('accepts the registry a WS-109 backend publishes', () => {
    const parsed = ForceRegistrySchema.safeParse({ md5: 'a'.repeat(32), forces: [{ index: 1, type: 'BOOL', value: '1' }] })
    expect(parsed.success).toBe(true)
  })

  it('rejects an entry without its type', () => {
    const parsed = ForceRegistrySchema.safeParse({ md5: 'a'.repeat(32), forces: [{ index: 1, value: '1' }] })
    expect(parsed.success).toBe(false)
  })
})

describe('getForceRegistry', () => {
  it('returns what the backend forced, authenticated', async () => {
    const client = await loggedInClient()
    mockResponse(['{"md5":"b1a8c0845d49d1bc43ac3b252b41788d","forces":[{"index":2,"type":"BOOL","value":"1"}]}'])

    const result = await client.getForceRegistry('192.168.1.50')

    expect(result.success).toBe(true)
    expect(result.md5).toBe('b1a8c0845d49d1bc43ac3b252b41788d')
    expect(result.forces).toEqual([{ index: 2, type: 'BOOL', value: '1' }])
    expect(requestMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: '/api/force' }),
      expect.any(Function),
    )
  })

  it('degrades to an empty registry when the body does not match the schema', async () => {
    const client = await loggedInClient()
    mockResponse(['{"md5":"x"}'])

    const result = await client.getForceRegistry('192.168.1.50')

    expect(result.success).toBe(true)
    expect(result.forces).toEqual([])
  })
})
