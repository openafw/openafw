// Forwarding-helper utilities. Filters hop-by-hop headers and adjusts the
// host header for the upstream target.

const REQUEST_HEADERS_TO_DROP = new Set([
  'host',
  'content-length',
  // Force uncompressed upstream responses so our decoder doesn't need to gunzip.
  'accept-encoding',
  'connection',
])

const RESPONSE_HEADERS_TO_DROP = new Set([
  'content-length',
  // Node's fetch (undici) auto-decompresses gzip/br/deflate but leaves the
  // Content-Encoding header on the response. Forwarding it to the client
  // makes the client try to decompress already-decompressed bytes
  // (ZlibError). Strip it so the client treats the body as identity.
  'content-encoding',
  'transfer-encoding',
  'connection',
])

export function filterRequestHeaders(input: Headers, upstreamHost: string): Headers {
  const out = new Headers()
  input.forEach((value, key) => {
    if (REQUEST_HEADERS_TO_DROP.has(key.toLowerCase())) return
    out.append(key, value)
  })
  out.set('host', upstreamHost)
  return out
}

export function filterResponseHeaders(input: Headers): Headers {
  const out = new Headers()
  input.forEach((value, key) => {
    if (RESPONSE_HEADERS_TO_DROP.has(key.toLowerCase())) return
    out.append(key, value)
  })
  return out
}
