/**
 * Force probe: does the EDITOR's own frame force a variable, and does the
 * target serve the forced value back?
 *
 * Reported symptom (2026-10-02, @micka): "forcing to false works everywhere,
 * forcing to true does not". Every UI path funnels into one encoder
 * (`buildSetVariableRequest`) and one client (`ModbusTcpClient.setVariable`), so
 * the question is whether the frame the editor sends is accepted, or whether the
 * fault sits above the transport. This probe drives the transport directly —
 * same client, same encoder, no UI — and reads the value back after each step.
 *
 *   npm run debug:force-probe -- [--index 2] [--host 127.0.0.1] [--port 502]
 *
 * The PLC must be RUNNING on that host/port (the Modbus debug channel only
 * exists after a successful start). Bytes are compared against what the UI
 * sends: "Force True" is `[01]`, "Force False" is `[00]`, release carries no
 * value.
 */
import { buildSetVariableRequest } from '../src/backend/shared/debug/modbus-pdu'
import { ModbusTcpClient } from '../src/backend/editor/modbus/modbus-client'

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const host = arg('--host', '127.0.0.1')
const port = Number(arg('--port', '502'))
const index = Number(arg('--index', '2'))

const hex = (bytes: Uint8Array | Buffer) =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ')

/**
 * The client hands back the raw response, so the probe prints its bytes: the
 * four readings then differ (or not) exactly where the value sits, which is all
 * this diagnostic needs.
 */
async function readValue(client: ModbusTcpClient, label: string): Promise<string> {
  const result = await client.getVariablesList([index])
  if (!result.success || !result.data) return `FAILED (${result.error ?? 'no data'})`
  const bytes = hex(result.data)
  console.log(`${label.padEnd(22)} -> ${bytes}`)
  return bytes
}

/**
 * Wrapped rather than using top-level `await`: that would make ts-node load the
 * file as ESM, where this repository's extensionless imports do not resolve.
 */
async function main(): Promise<void> {
  const client = new ModbusTcpClient({ host, port, timeout: 5000 })
  try {
    await client.connect()
    console.log(`connected to ${host}:${port}, watching index ${index}\n`)

    console.log('frames the editor builds:')
    console.log(`  force true  [01] : ${hex(buildSetVariableRequest(index, true, new Uint8Array([1])))}`)
    console.log(`  force false [00] : ${hex(buildSetVariableRequest(index, true, new Uint8Array([0])))}`)
    console.log(`  release          : ${hex(buildSetVariableRequest(index, false))}\n`)

    const before = await readValue(client, 'before')
    const send = async (label: string, force: boolean, value?: Buffer) => {
      const result = await client.setVariable(index, force, value)
      console.log(`${label.padEnd(22)} -> ${JSON.stringify(result)}`)
      return readValue(client, `after ${label.trim()}`)
    }
    const forcedTrue = await send('force true  [01]', true, Buffer.from([1]))
    const forcedFalse = await send('force false [00]', true, Buffer.from([0]))
    const released = await send('release', false)

    console.log('\nsummary:')
    console.log(`  before        ${before}`)
    console.log(`  forced true   ${forcedTrue}`)
    console.log(`  forced false  ${forcedFalse}`)
    console.log(`  released      ${released}`)
  } finally {
    client.disconnect()
  }
}

void main().catch((error: unknown) => {
  console.error('probe failed:', error)
  process.exit(1)
})
