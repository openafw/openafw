import type { Context } from 'hono'
import { logger } from '../../core/logger.ts'
import { ingestMcpFrame } from '../mcp/ingest.ts'

type FrameBody = {
  agent: string
  server: string
  ts: number
  direction: 'request' | 'response' | 'notification'
  // biome-ignore lint/suspicious/noExplicitAny: third-party JSON-RPC payload
  frame: any
}

export async function handleTapFrame(c: Context): Promise<Response> {
  let body: FrameBody
  try {
    body = (await c.req.json()) as FrameBody
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }

  const f = body.frame
  if (!f || typeof f !== 'object') {
    return c.json({ error: 'frame missing' }, 400)
  }

  await ingestMcpFrame({
    agent: body.agent,
    server: body.server,
    transport: 'stdio',
    direction: body.direction,
    frame: f,
    ts: body.ts,
  })
  logger.debug(`tap: ${body.agent}/${body.server} ${body.direction} ${f.method ?? f.id ?? '?'}`)

  return c.json({ ok: true })
}
