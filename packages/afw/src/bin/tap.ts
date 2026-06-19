#!/usr/bin/env node
// afw-tap — stdio bridge for MCP servers spawned by wired agents.
//
// Bidirectional passthrough between the parent (agent) and the child
// (MCP server). On every newline-delimited JSON object (the stdio
// JSON-RPC framing), fire-and-forget POST the frame to the local daemon.
// Bytes are forwarded immediately — logging never blocks the bridge.

import { spawn } from 'node:child_process'
import process from 'node:process'

const args = process.argv.slice(2)
const sep = args.indexOf('--')
if (sep < 0) {
  process.stderr.write(
    'afw-tap: missing -- separator; expected --agent X --server Y -- <cmd> [args...]\n',
  )
  process.exit(2)
}

const flags = args.slice(0, sep)
const cmd = args[sep + 1]
const cmdArgs = args.slice(sep + 2)
if (!cmd) {
  process.stderr.write('afw-tap: no command specified after --\n')
  process.exit(2)
}

const AGENT = readFlag(flags, '--agent') ?? 'unknown'
const SERVER = readFlag(flags, '--server') ?? 'unknown'
const DAEMON_URL = process.env.AFW_DAEMON_URL ?? 'http://localhost:9877'

const child = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'inherit'] })
if (!child.stdin || !child.stdout) {
  process.stderr.write('afw-tap: failed to open child stdio\n')
  process.exit(2)
}

forward(process.stdin, child.stdin, 'request')
forward(child.stdout, process.stdout, 'response')

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
child.on('error', (err) => {
  process.stderr.write(`afw-tap: child error: ${err.message}\n`)
  process.exit(2)
})
process.on('SIGTERM', () => child.kill('SIGTERM'))
process.on('SIGINT', () => child.kill('SIGINT'))

type Direction = 'request' | 'response'

function forward(
  src: NodeJS.ReadableStream,
  dst: NodeJS.WritableStream,
  direction: Direction,
): void {
  let buf = ''
  src.on('data', (chunk: Buffer | string) => {
    // Forward bytes immediately. Never block.
    dst.write(chunk)

    // Side-channel: parse JSON-RPC frames (line-delimited).
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line.length > 0) emitFrame(line, direction)
    }
  })
  src.on('end', () => {
    if (buf.trim().length > 0) emitFrame(buf.trim(), direction)
    dst.end()
  })
}

function emitFrame(line: string, direction: Direction): void {
  let frame: unknown
  try {
    frame = JSON.parse(line)
  } catch {
    return // not JSON; skip (server prelude logs, etc.)
  }

  void fetch(`${DAEMON_URL}/api/tap/frame`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agent: AGENT,
      server: SERVER,
      ts: Date.now(),
      direction,
      frame,
    }),
  }).catch(() => {
    // Daemon down → drop silently. Tap stays invisible.
  })
}

function readFlag(flags: string[], name: string): string | undefined {
  const i = flags.indexOf(name)
  return i >= 0 && i + 1 < flags.length ? flags[i + 1] : undefined
}
