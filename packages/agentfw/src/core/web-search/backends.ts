// Web search backends. Each one is a pure async function:
//   search(opts) → { results: WebSearchResult[] }  or  { error: string }
//
// No file I/O, no MCP coupling, no daemon dependency — the agentfw-tools
// MCP binary picks a backend by ToolProvider config and calls these
// directly. parseDuckDuckGoHtml / parseBraveJson are exported so unit
// tests can feed fixtures without mocking fetch.

export type WebSearchResult = {
  title: string
  url: string
  snippet?: string
}

export type WebSearchSuccess = { ok: true; results: WebSearchResult[] }
export type WebSearchFailure = { ok: false; error: string }
export type WebSearchOutcome = WebSearchSuccess | WebSearchFailure

export type SearchOpts = {
  query: string
  count?: number
  /** Backend-specific. DDG ignores; Brave forwards as `country`; SearXNG
   *  forwards as `language`; Tavily ignores. */
  locale?: string
}

// ── DuckDuckGo HTML endpoint ──────────────────────────────────────

const DDG_URL = 'https://html.duckduckgo.com/html/'
const DDG_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'

export async function searchDuckDuckGo(opts: SearchOpts): Promise<WebSearchOutcome> {
  const form = new URLSearchParams({ q: opts.query })
  let res: Response
  try {
    res = await fetch(DDG_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': DDG_USER_AGENT,
        accept: 'text/html',
      },
      body: form.toString(),
    })
  } catch (err) {
    return { ok: false, error: `duckduckgo unreachable: ${(err as Error).message}` }
  }
  if (!res.ok) {
    return { ok: false, error: `duckduckgo HTTP ${res.status}` }
  }
  const html = await res.text()
  if (isDuckDuckGoAnomalyPage(html)) {
    return {
      ok: false,
      error:
        'DuckDuckGo flagged this request as bot traffic and served a challenge page. ' +
        'This often resolves after a few minutes; for sustained use, switch to a ' +
        'key-based backend (Brave Search API) in Control · Tool Providers.',
    }
  }
  const results = parseDuckDuckGoHtml(html).slice(0, opts.count ?? 10)
  return { ok: true, results }
}

/** True when DDG returned its bot-challenge page instead of search
 *  results. The anomaly form's action URL is the strongest signal. */
export function isDuckDuckGoAnomalyPage(html: string): boolean {
  return /anomaly\.js/.test(html) || /id="challenge-form"/.test(html)
}

/** Parse DDG's HTML results page. Their non-JS endpoint renders each
 *  result as a `result__a` anchor + `result__snippet` span. URLs come
 *  through a `//duckduckgo.com/l/?uddg=<encoded>` redirector — we
 *  decode the inner URL so callers get the real destination. The
 *  parser is intentionally a regex scan (no DOM lib) so it works in
 *  the daemon's plain node runtime; markup churn risk is the tradeoff. */
export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const anchorRe =
    /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe =
    /<(?:a|span)[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span)>/g
  const snippets: string[] = []
  let s: RegExpExecArray | null
  while ((s = snippetRe.exec(html)) !== null) {
    snippets.push(stripHtml(s[1] ?? ''))
  }
  let i = 0
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(html)) !== null) {
    const rawHref = decodeHtmlEntities(m[1] ?? '')
    const url = unwrapDdgRedirect(rawHref)
    const title = stripHtml(m[2] ?? '')
    if (!url || !title) {
      i++
      continue
    }
    const snippet = snippets[i]
    results.push(snippet ? { title, url, snippet } : { title, url })
    i++
  }
  return results
}

function unwrapDdgRedirect(href: string): string {
  // DDG wraps every external link in /l/?uddg=<urlencoded>&...
  // Accept absolute or schemeless forms.
  const m = /[?&]uddg=([^&]+)/.exec(href)
  if (m?.[1]) {
    try {
      return decodeURIComponent(m[1])
    } catch {
      return ''
    }
  }
  if (href.startsWith('//')) return `https:${href}`
  if (href.startsWith('http')) return href
  return ''
}

function stripHtml(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

// ── Brave Search API ──────────────────────────────────────────────

const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search'

export type BraveOpts = SearchOpts & { apiKey: string }

export async function searchBrave(opts: BraveOpts): Promise<WebSearchOutcome> {
  const url = new URL(BRAVE_URL)
  url.searchParams.set('q', opts.query)
  url.searchParams.set('count', String(opts.count ?? 10))
  if (opts.locale) url.searchParams.set('country', opts.locale)
  let res: Response
  try {
    res = await fetch(url, {
      headers: {
        accept: 'application/json',
        'x-subscription-token': opts.apiKey,
      },
    })
  } catch (err) {
    return { ok: false, error: `brave unreachable: ${(err as Error).message}` }
  }
  const text = await res.text()
  if (!res.ok) {
    return { ok: false, error: `brave HTTP ${res.status}: ${text.slice(0, 200)}` }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: `brave returned non-JSON: ${text.slice(0, 200)}` }
  }
  return { ok: true, results: parseBraveJson(json).slice(0, opts.count ?? 10) }
}

export function parseBraveJson(json: unknown): WebSearchResult[] {
  if (typeof json !== 'object' || json === null) return []
  const web = (json as { web?: { results?: unknown } }).web
  if (!web || !Array.isArray(web.results)) return []
  const out: WebSearchResult[] = []
  for (const r of web.results) {
    if (typeof r !== 'object' || r === null) continue
    const row = r as Record<string, unknown>
    const title = typeof row.title === 'string' ? row.title : ''
    const url = typeof row.url === 'string' ? row.url : ''
    const description = typeof row.description === 'string' ? row.description : ''
    if (!title || !url) continue
    out.push(description ? { title, url, snippet: description } : { title, url })
  }
  return out
}

// ── Baidu AI Search (Qianfan) ─────────────────────────────────────
//
// Two endpoints sit behind one backend, each with its own quota tier:
//
//   smart search (chat/completions) — generative; 100 free calls/day.
//     Returns `choices[].message.content` (LLM summary) + `references[]`.
//   plain web_search                  — pure SERP; 1500 free calls/month.
//     Returns `references[]` only.
//
// `searchBaidu` tries smart search first to amortise the higher daily
// quota, then falls back to plain web_search when smart search refuses
// (HTTP 4xx/5xx, network error, or a body-level `{code, message}`
// error — Baidu's preferred way of signalling "quota exceeded" or other
// upstream problems on a 200).
//
// Endpoint shape and auth shape lifted from references/baidu-search-1.1.4
// (OpenClaw's BAIDU_API_KEY skill). The official console for getting a
// key is https://console.bce.baidu.com/ai-search/qianfan/ais/console/apiKey.

const BAIDU_SMART_URL = 'https://qianfan.baidubce.com/v2/ai_search/chat/completions'
const BAIDU_WEB_URL = 'https://qianfan.baidubce.com/v2/ai_search/web_search'

// Lightweight default — Baidu's docs list this as a small/fast tier
// covered by the smart-search quota. Switching to a thinking model
// (`deepseek-r1`, `ernie-x1`) would burn the quota faster without
// changing the references[] we actually consume.
const BAIDU_SMART_MODEL = 'ernie-4.5-turbo-32k'

export type BaiduOpts = SearchOpts & {
  apiKey: string
  /** Time-range filter — Baidu's "freshness" parameter. Accepts the
   *  shortcuts `pd` / `pw` / `pm` / `py` (past day / week / month / year)
   *  or a literal `YYYY-MM-DDtoYYYY-MM-DD` window. Forwarded as
   *  `search_filter.range.page_time` to both endpoints (v2 supports it). */
  freshness?: string
}

export async function searchBaidu(opts: BaiduOpts): Promise<WebSearchOutcome> {
  const smart = await searchBaiduSmart(opts)
  if (smart.ok) return smart
  const plain = await searchBaiduWeb(opts)
  if (plain.ok) return plain
  // Both failed — surface both reasons so the user sees what's broken.
  return {
    ok: false,
    error: `baidu smart-search failed (${smart.error}); plain web_search also failed (${plain.error})`,
  }
}

/** Smart search via /v2/ai_search/chat/completions. Carries a model
 *  parameter (the LLM summary is discarded by agentfw — the routed
 *  model synthesises its own answer — but the references[] field is
 *  the same shape we consume from plain web_search). */
export async function searchBaiduSmart(opts: BaiduOpts): Promise<WebSearchOutcome> {
  const count = Math.max(1, Math.min(20, opts.count ?? 10))
  const body: Record<string, unknown> = {
    messages: [{ role: 'user', content: opts.query }],
    model: BAIDU_SMART_MODEL,
    search_source: 'baidu_search_v2',
    stream: false,
    resource_type_filter: [{ type: 'web', top_k: count }],
    // Disable extras that aren't relevant to a tool-call: no follow-up
    // suggestions, no reasoning trace, no deep search expansion.
    enable_reasoning: false,
    enable_deep_search: false,
    enable_followup_queries: false,
    search_mode: 'required',
  }
  const filter = freshnessToFilter(opts.freshness)
  if (filter) body.search_filter = filter
  return callBaidu(BAIDU_SMART_URL, opts.apiKey, body, count)
}

/** Plain web search via /v2/ai_search/web_search. No model invocation,
 *  larger monthly quota — the fallback when smart search refuses. */
export async function searchBaiduWeb(opts: BaiduOpts): Promise<WebSearchOutcome> {
  const count = Math.max(1, Math.min(50, opts.count ?? 10))
  const body: Record<string, unknown> = {
    messages: [{ role: 'user', content: opts.query }],
    search_source: 'baidu_search_v2',
    resource_type_filter: [{ type: 'web', top_k: count }],
  }
  const filter = freshnessToFilter(opts.freshness)
  if (filter) body.search_filter = filter
  return callBaidu(BAIDU_WEB_URL, opts.apiKey, body, count)
}

async function callBaidu(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  count: number,
): Promise<WebSearchOutcome> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        // Baidu's API wants a `From` tag identifying the integration —
        // OpenClaw uses 'openclaw'; we identify as 'agentfw' so the
        // upstream's telemetry attributes our traffic correctly.
        'x-appbuilder-from': 'agentfw',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    return { ok: false, error: `baidu unreachable: ${(err as Error).message}` }
  }
  const text = await res.text()
  if (!res.ok) {
    return { ok: false, error: `baidu HTTP ${res.status}: ${text.slice(0, 200)}` }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: `baidu returned non-JSON: ${text.slice(0, 200)}` }
  }
  // Baidu signals errors with a body-level { code, message } on a 200
  // response — most often when the daily/monthly quota is exhausted.
  if (
    json &&
    typeof json === 'object' &&
    'code' in json &&
    (json as Record<string, unknown>).code
  ) {
    const msg = (json as Record<string, unknown>).message
    return {
      ok: false,
      error: `baidu error: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`,
    }
  }
  return { ok: true, results: parseBaiduJson(json).slice(0, count) }
}

export function parseBaiduJson(json: unknown): WebSearchResult[] {
  if (typeof json !== 'object' || json === null) return []
  const refs = (json as { references?: unknown }).references
  if (!Array.isArray(refs)) return []
  const out: WebSearchResult[] = []
  for (const r of refs) {
    if (typeof r !== 'object' || r === null) continue
    const row = r as Record<string, unknown>
    const title = typeof row.title === 'string' ? row.title : ''
    const url = typeof row.url === 'string' ? row.url : ''
    // Some plan tiers return `snippet`, some `content`; either is fine.
    const snippetField =
      typeof row.snippet === 'string'
        ? row.snippet
        : typeof row.content === 'string'
          ? row.content
          : ''
    if (!title || !url) continue
    out.push(snippetField ? { title, url, snippet: snippetField } : { title, url })
  }
  return out
}

/** Map the Baidu `freshness` shorthand to its `search_filter` JSON.
 *  Returns undefined when freshness is absent or malformed (caller
 *  omits the filter so Baidu's default time range applies). */
function freshnessToFilter(
  freshness: string | undefined,
): Record<string, unknown> | undefined {
  if (!freshness) return undefined
  const now = new Date()
  const dayShift = (n: number): string => {
    const d = new Date(now)
    d.setUTCDate(d.getUTCDate() - n)
    return d.toISOString().slice(0, 10)
  }
  const tomorrow = (() => {
    const d = new Date(now)
    d.setUTCDate(d.getUTCDate() + 1)
    return d.toISOString().slice(0, 10)
  })()
  let start: string | undefined
  let end: string = tomorrow
  if (freshness === 'pd') start = dayShift(1)
  else if (freshness === 'pw') start = dayShift(6)
  else if (freshness === 'pm') start = dayShift(30)
  else if (freshness === 'py') start = dayShift(364)
  else {
    const m = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/.exec(freshness)
    if (!m) return undefined
    start = m[1]
    end = m[2] ?? end
  }
  return { range: { page_time: { gte: start, lt: end } } }
}
