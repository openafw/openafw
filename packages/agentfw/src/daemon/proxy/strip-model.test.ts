import { describe, expect, it } from 'vitest'
import type { RouteEntry } from '../../core/routes.ts'
import { rewriteModelForUpstream, stripModelDisplaySuffix } from './index.ts'

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o)).buffer as ArrayBuffer
const modelOf = (buf: ArrayBuffer | undefined) =>
  buf ? (JSON.parse(new TextDecoder().decode(buf)) as { model?: string }).model : undefined

describe('stripModelDisplaySuffix', () => {
  it('strips the 1M-context display suffix that is not a real API model', () => {
    expect(stripModelDisplaySuffix('claude-opus-4-8[1m]')).toBe('claude-opus-4-8')
    expect(stripModelDisplaySuffix('claude-opus-4-7[1m]')).toBe('claude-opus-4-7')
    expect(stripModelDisplaySuffix('claude-sonnet-4-6 [1m]')).toBe('claude-sonnet-4-6')
  })

  it('leaves real model ids untouched', () => {
    expect(stripModelDisplaySuffix('claude-opus-4-8')).toBe('claude-opus-4-8')
    expect(stripModelDisplaySuffix('gpt-4o')).toBe('gpt-4o')
    expect(stripModelDisplaySuffix('og-coding')).toBe('og-coding')
  })

  it('never blanks the model (suffix-only / empty result falls back)', () => {
    expect(stripModelDisplaySuffix('[1m]')).toBe('[1m]')
    expect(stripModelDisplaySuffix('')).toBe('')
  })
})

describe('rewriteModelForUpstream', () => {
  const wildcard: RouteEntry = { upstream: 'https://api.anthropic.com', decoder: 'anthropic' }
  const wrap: RouteEntry = {
    upstream: 'https://x',
    decoder: 'openai-chat',
    sourceModelId: 'og-coding',
  }

  it('strips [1m] for a wildcard (no sourceModelId) route', () => {
    const out = rewriteModelForUpstream(
      enc({ model: 'claude-opus-4-8[1m]', messages: [] }),
      wildcard,
    )
    expect(modelOf(out)).toBe('claude-opus-4-8')
  })

  it('sourceModelId wins over the body model (wrap-style swap)', () => {
    const out = rewriteModelForUpstream(enc({ model: 'agentfw-openclaw-main', messages: [] }), wrap)
    expect(modelOf(out)).toBe('og-coding')
  })

  it('no-op for a plain model on a wildcard route (returns body unchanged)', () => {
    const body = enc({ model: 'claude-opus-4-8', messages: [] })
    expect(rewriteModelForUpstream(body, wildcard)).toBe(body)
  })

  it('leaves a non-JSON body alone', () => {
    const body = new TextEncoder().encode('not json').buffer as ArrayBuffer
    expect(rewriteModelForUpstream(body, wildcard)).toBe(body)
  })
})
