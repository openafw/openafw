// web_fetch backend. A focused HTTP GET that returns extracted text
// from a URL, with a host allowlist to keep the model from probing the
// user's internal network. Used by the afw-tools MCP binary.
//
// Default policy is "any public URL, never anything that could resolve
// to localhost or a private network." That's enough for "go look at
// this page on the web" without giving the agent a way to enumerate
// the user's intranet, hit cloud metadata endpoints, or reach a
// link-local address.

export type FetchOpts = {
  url: string
  /** Hard cap on response bytes read (default 1 MiB). */
  maxBytes?: number
  /** Per-request timeout in ms (default 15s). */
  timeoutMs?: number
}

export type FetchSuccess = {
  ok: true
  url: string
  /** Final URL after redirects (may differ from input). */
  finalUrl: string
  status: number
  contentType: string
  title?: string
  text: string
  truncated: boolean
}
export type FetchFailure = { ok: false; error: string }
export type FetchOutcome = FetchSuccess | FetchFailure

const FETCH_USER_AGENT = 'afw-tools/0.1 (+https://openafw.com)'
const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15_000

export async function fetchUrl(opts: FetchOpts): Promise<FetchOutcome> {
  const policy = checkUrlPolicy(opts.url)
  if (!policy.ok) return policy

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(opts.url, {
      headers: { 'user-agent': FETCH_USER_AGENT, accept: 'text/html, text/plain, */*' },
      redirect: 'follow',
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    return { ok: false, error: `fetch failed: ${(err as Error).message}` }
  }
  clearTimeout(timer)

  // Re-check the final URL after redirects — a 30x to a private address
  // would otherwise sneak past the initial policy check.
  const finalPolicy = checkUrlPolicy(res.url)
  if (!finalPolicy.ok) return finalPolicy

  const contentType = res.headers.get('content-type') ?? ''
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const { text, truncated } = await readBounded(res, maxBytes)

  const isHtml = /\bhtml\b/i.test(contentType) || /^\s*<!doctype html/i.test(text)
  const extracted = isHtml ? htmlToText(text) : text.trim()
  const title = isHtml ? extractTitle(text) : undefined

  return {
    ok: true,
    url: opts.url,
    finalUrl: res.url,
    status: res.status,
    contentType,
    ...(title ? { title } : {}),
    text: extracted,
    truncated,
  }
}

/** Reject URLs that point at the local machine, private networks,
 *  link-local space, or cloud metadata endpoints. Operates on the URL
 *  string only (no DNS resolution) — for ip-literal hosts this is
 *  exact; for DNS names we still let the request go and re-check after
 *  redirect. Bypassing this via DNS rebinding would need a layered
 *  network policy (out of scope for v0). */
export function checkUrlPolicy(rawUrl: string): { ok: true } | { ok: false; error: string } {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, error: 'invalid url' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `unsupported scheme: ${url.protocol}` }
  }
  const host = url.hostname.toLowerCase()
  if (BLOCKED_HOSTS.has(host)) {
    return { ok: false, error: `host "${host}" is on the local-network deny list` }
  }
  if (isPrivateIpLiteral(host)) {
    return { ok: false, error: `host "${host}" resolves to a private/local network` }
  }
  return { ok: true }
}

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
  '127.0.0.1',
  '::1',
  // EC2/GCE/Azure instance metadata. Even though this is an IP, also
  // keep the literal here in case someone passes it via a host name
  // alias that resolves to it.
  '169.254.169.254',
  'metadata.google.internal',
])

/** True if the host is an IPv4 or IPv6 literal inside a private /
 *  loopback / link-local range. Pure parse, no DNS. */
export function isPrivateIpLiteral(host: string): boolean {
  // IPv6 literals in URLs are wrapped in brackets — URL().hostname
  // strips them. Lowercase comparison handles both upper and
  // lower-case hex.
  if (host.includes(':')) {
    if (
      host === '::1' ||
      host.startsWith('fe80:') ||
      host.startsWith('fc') ||
      host.startsWith('fd')
    ) {
      return true
    }
    return false
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // 127.0.0.0/8
  if (a === 169 && b === 254) return true // 169.254.0.0/16 (link-local)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 (CGNAT)
  if (a === 0) return true // 0.0.0.0/8
  return false
}

async function readBounded(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    if (total + value.byteLength > maxBytes) {
      const remaining = Math.max(0, maxBytes - total)
      if (remaining > 0) chunks.push(value.subarray(0, remaining))
      total += remaining
      truncated = true
      try {
        await reader.cancel()
      } catch {
        // Cancel best-effort; we already have what we need.
      }
      break
    }
    chunks.push(value)
    total += value.byteLength
  }
  const merged = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    merged.set(c, off)
    off += c.byteLength
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(merged), truncated }
}

export function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!m?.[1]) return undefined
  const stripped = m[1].replace(/\s+/g, ' ').trim()
  return stripped || undefined
}

/** Pretty-bad HTML→text extractor. Drops <script>/<style> contents
 *  entirely, strips remaining tags, decodes a handful of entities,
 *  collapses runs of whitespace. Good enough for "let the model read
 *  this page" — not for archival fidelity. Kept dependency-free so
 *  the binary stays small. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\s*[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  )
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n)
      return Number.isFinite(code) && code >= 0x20 && code < 0x10000
        ? String.fromCodePoint(code)
        : ''
    })
}
