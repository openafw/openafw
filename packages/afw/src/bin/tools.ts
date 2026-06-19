#!/usr/bin/env node
// afw-tools — stdio MCP server exposing harness-provided tools to
// any wired agent. Ships `web_search` and `web_fetch`; future capabilities
// (browser, image gen, etc.) land here under the same process so a single
// mcpServers entry in the agent's config covers the whole afw tool
// surface.
//
// Why a separate binary: MCP convention is one stdio process per
// server. The agent spawns this on its own schedule and keeps it
// alive — we can't share state with the daemon. Backend config is
// re-read on every call (cheap) so the user can swap providers in the
// UI without restarting the agent.
//
// Privacy: this binary makes outbound calls to the user-chosen
// backend (DuckDuckGo HTML, Brave API, SearXNG, Tavily). It does NOT
// contact any openafw.com or Anthropic host. Within PRIVACY.md.

import process from 'node:process'
import { getSecret, readSecrets } from '../core/secrets.ts'
import { type ToolProvider, activeProviderFor, readToolProviders } from '../core/tool-providers.ts'
import {
  type WebSearchOutcome,
  type WebSearchResult,
  parseBraveJson,
  parseDuckDuckGoHtml,
  searchBaidu,
  searchBrave,
  searchDuckDuckGo,
} from '../core/web-search/backends.ts'
import { type FetchOutcome, fetchUrl } from '../core/web-search/fetch.ts'

// Silence references the bundler would flag as unused — these are
// re-exported from this module's import site so tests can poke them
// without dragging in the binary's stdio runtime.
void parseBraveJson
void parseDuckDuckGoHtml

const SERVER_NAME = 'afw-tools'
const SERVER_VERSION = '0.1.0'
const PROTOCOL_VERSION = '2024-11-05'

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: unknown
}
type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

// ── tool definition ───────────────────────────────────────────────

const WEB_SEARCH_TOOL = {
  name: 'web_search',
  description:
    'Search the web via the user-configured backend (DuckDuckGo, Brave, SearXNG, or Tavily). ' +
    'Returns a list of {title, url, snippet} results. Use when you need current information ' +
    'beyond your training cutoff or to locate a specific page.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
      count: {
        type: 'number',
        description: 'Maximum number of results to return (default 10).',
        minimum: 1,
        maximum: 25,
      },
    },
    required: ['query'],
  },
} as const

const WEB_FETCH_TOOL = {
  name: 'web_fetch',
  description:
    'Fetch a public web URL and return its title plus extracted text content. ' +
    'Blocks requests to localhost, private networks, and cloud metadata endpoints — ' +
    "the model cannot probe the user's intranet. Follows redirects; responses are " +
    'truncated at ~1 MiB.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The absolute http(s) URL to fetch.' },
      maxBytes: {
        type: 'number',
        description: 'Cap on response bytes read (default 1048576).',
        minimum: 1024,
        maximum: 4 * 1024 * 1024,
      },
    },
    required: ['url'],
  },
} as const

// ── stdio JSON-RPC plumbing ───────────────────────────────────────

function send(msg: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

function err(id: number | string | null, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function dispatch(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null
  switch (req.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} },
        },
      })
      return
    case 'notifications/initialized':
      // No reply for notifications.
      return
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: [WEB_SEARCH_TOOL, WEB_FETCH_TOOL] } })
      return
    case 'tools/call': {
      const params = (req.params ?? {}) as { name?: string; arguments?: unknown }
      if (params.name === 'web_search') {
        const args = (params.arguments ?? {}) as { query?: unknown; count?: unknown }
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        if (!query) {
          err(id, -32602, 'web_search: `query` is required')
          return
        }
        const count =
          typeof args.count === 'number' && args.count > 0 ? Math.min(25, args.count) : 10
        const outcome = await runWebSearch({ query, count })
        send({ jsonrpc: '2.0', id, result: toSearchToolResult(outcome) })
        return
      }
      if (params.name === 'web_fetch') {
        const args = (params.arguments ?? {}) as { url?: unknown; maxBytes?: unknown }
        const url = typeof args.url === 'string' ? args.url.trim() : ''
        if (!url) {
          err(id, -32602, 'web_fetch: `url` is required')
          return
        }
        const maxBytes =
          typeof args.maxBytes === 'number' && args.maxBytes > 0 ? args.maxBytes : undefined
        const outcome = await fetchUrl({ url, ...(maxBytes ? { maxBytes } : {}) })
        send({ jsonrpc: '2.0', id, result: toFetchToolResult(outcome) })
        return
      }
      err(id, -32601, `unknown tool: ${String(params.name)}`)
      return
    }
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} })
      return
    default:
      err(id, -32601, `method not implemented: ${req.method}`)
  }
}

// ── search dispatch ───────────────────────────────────────────────

async function runWebSearch(opts: {
  query: string
  count: number
}): Promise<WebSearchOutcome> {
  let provider: ToolProvider | undefined
  try {
    const store = await readToolProviders()
    provider = activeProviderFor(store, 'web_search')
  } catch (e) {
    return { ok: false, error: `tool-providers.json unreadable: ${(e as Error).message}` }
  }
  if (!provider) {
    return {
      ok: false,
      error: 'no web_search backend configured — add one in Control · Tool Providers',
    }
  }

  switch (provider.backend) {
    case 'duckduckgo':
      return searchDuckDuckGo({ query: opts.query, count: opts.count })
    case 'brave': {
      const apiKey = await resolveSecret(provider)
      if (!apiKey) return { ok: false, error: `provider "${provider.id}" is missing its API key` }
      return searchBrave({ query: opts.query, count: opts.count, apiKey })
    }
    case 'baidu': {
      const apiKey = await resolveSecret(provider)
      if (!apiKey) return { ok: false, error: `provider "${provider.id}" is missing its API key` }
      return searchBaidu({ query: opts.query, count: opts.count, apiKey })
    }
    case 'searxng':
    case 'tavily':
      return { ok: false, error: `backend "${provider.backend}" is not implemented yet` }
  }
}

async function resolveSecret(p: ToolProvider): Promise<string | undefined> {
  if (!p.authRef) return undefined
  try {
    const secrets = await readSecrets()
    return getSecret(secrets, p.authRef) ?? undefined
  } catch {
    return undefined
  }
}

function toSearchToolResult(outcome: WebSearchOutcome): unknown {
  if (!outcome.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: `web_search failed: ${outcome.error}` }],
    }
  }
  return {
    content: [{ type: 'text', text: formatResults(outcome.results) }],
  }
}

function toFetchToolResult(outcome: FetchOutcome): unknown {
  if (!outcome.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: `web_fetch failed: ${outcome.error}` }],
    }
  }
  const header = [
    `URL: ${outcome.finalUrl}${outcome.finalUrl !== outcome.url ? ` (from ${outcome.url})` : ''}`,
    `Status: ${outcome.status}`,
    outcome.contentType ? `Content-Type: ${outcome.contentType}` : '',
    outcome.title ? `Title: ${outcome.title}` : '',
    outcome.truncated ? '(response truncated at maxBytes)' : '',
  ]
    .filter(Boolean)
    .join('\n')
  return {
    content: [{ type: 'text', text: `${header}\n\n${outcome.text}` }],
  }
}

function formatResults(results: WebSearchResult[]): string {
  if (results.length === 0) return 'No results.'
  const lines: string[] = []
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`)
    lines.push(`   ${r.url}`)
    if (r.snippet) lines.push(`   ${r.snippet}`)
    lines.push('')
  })
  return lines.join('\n').trimEnd()
}

// ── stdin pump ────────────────────────────────────────────────────

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buf += chunk
  let nl: number
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let req: JsonRpcRequest
    try {
      req = JSON.parse(line) as JsonRpcRequest
    } catch (e) {
      err(null, -32700, `parse error: ${(e as Error).message}`)
      continue
    }
    void dispatch(req).catch((e) => err(req.id ?? null, -32000, (e as Error).message))
  }
})
process.stdin.on('end', () => {
  process.exit(0)
})
