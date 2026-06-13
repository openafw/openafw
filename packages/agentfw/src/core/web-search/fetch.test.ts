import { describe, expect, it } from 'vitest'
import {
  checkUrlPolicy,
  extractTitle,
  htmlToText,
  isPrivateIpLiteral,
} from './fetch.ts'

describe('isPrivateIpLiteral', () => {
  it('classifies IPv4 private + loopback + link-local ranges', () => {
    for (const host of [
      '127.0.0.1',
      '127.99.99.99',
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // EC2 metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
    ]) {
      expect(isPrivateIpLiteral(host), host).toBe(true)
    }
  })

  it('lets public IPv4 through', () => {
    for (const host of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '11.0.0.1']) {
      expect(isPrivateIpLiteral(host), host).toBe(false)
    }
  })

  it('flags IPv6 loopback / link-local / unique-local', () => {
    expect(isPrivateIpLiteral('::1')).toBe(true)
    expect(isPrivateIpLiteral('fe80::1')).toBe(true)
    expect(isPrivateIpLiteral('fc00::1')).toBe(true) // ULA
    expect(isPrivateIpLiteral('fd12:3456::1')).toBe(true)
  })

  it('returns false for hostnames', () => {
    expect(isPrivateIpLiteral('example.com')).toBe(false)
  })
})

describe('checkUrlPolicy', () => {
  it('blocks localhost + loopback + metadata + private IPs', () => {
    for (const url of [
      'http://localhost/x',
      'http://127.0.0.1:9877/health',
      'https://10.0.0.5/secret',
      'http://192.168.1.1/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
    ]) {
      const r = checkUrlPolicy(url)
      expect(r.ok, url).toBe(false)
    }
  })

  it('rejects non-http(s) schemes', () => {
    expect(checkUrlPolicy('file:///etc/passwd').ok).toBe(false)
    expect(checkUrlPolicy('javascript:alert(1)').ok).toBe(false)
    expect(checkUrlPolicy('data:text/html,hi').ok).toBe(false)
  })

  it('rejects malformed URLs', () => {
    expect(checkUrlPolicy('not a url').ok).toBe(false)
  })

  it('allows public URLs', () => {
    expect(checkUrlPolicy('https://example.com/').ok).toBe(true)
    expect(checkUrlPolicy('https://api.openai.com/v1/models').ok).toBe(true)
  })
})

describe('extractTitle', () => {
  it('pulls a normal <title>', () => {
    expect(extractTitle('<head><title> Hello World </title></head>')).toBe('Hello World')
  })

  it('returns undefined when missing', () => {
    expect(extractTitle('<html><body>no head</body></html>')).toBeUndefined()
  })
})

describe('htmlToText', () => {
  it('drops scripts and styles, keeps paragraph text', () => {
    const html =
      '<html><body><script>alert(1)</script><style>p{}</style><p>Hello &amp; goodbye.</p></body></html>'
    const out = htmlToText(html)
    expect(out).toContain('Hello & goodbye.')
    expect(out).not.toContain('alert')
    expect(out).not.toContain('p{}')
  })

  it('inserts newlines for paragraph / heading boundaries', () => {
    const out = htmlToText('<h1>Title</h1><p>One.</p><p>Two.</p>')
    expect(out).toMatch(/Title[\s\S]*One\.[\s\S]*Two\./)
    expect(out.split(/\n+/).length).toBeGreaterThanOrEqual(2)
  })
})
