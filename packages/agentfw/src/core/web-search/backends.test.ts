import { describe, expect, it } from 'vitest'
import {
  isDuckDuckGoAnomalyPage,
  parseBaiduJson,
  parseBraveJson,
  parseDuckDuckGoHtml,
} from './backends.ts'

describe('parseDuckDuckGoHtml', () => {
  it('extracts title, decoded url, and snippet from a typical result', () => {
    // Minimal DDG-shape HTML — captures the markers the parser depends
    // on (result__a anchor + result__snippet sibling). Keeping the
    // fixture short so a real markup change is obvious in diff.
    const html = `
      <div class="result">
        <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffoo&amp;rut=x">
          Example &amp; Foo
        </a></h2>
        <a class="result__snippet" href="...">
          A short <b>matching</b> excerpt.
        </a>
      </div>
    `
    const out = parseDuckDuckGoHtml(html)
    expect(out).toEqual([
      {
        title: 'Example & Foo',
        url: 'https://example.com/foo',
        snippet: 'A short matching excerpt.',
      },
    ])
  })

  it('skips results whose url cannot be unwrapped', () => {
    const html = `
      <a class="result__a" href="javascript:void(0)">Bad</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fok.example.com%2F">Good</a>
    `
    const out = parseDuckDuckGoHtml(html)
    expect(out).toHaveLength(1)
    expect(out[0]?.url).toBe('https://ok.example.com/')
  })

  it('returns empty for an empty page', () => {
    expect(parseDuckDuckGoHtml('')).toEqual([])
  })
})

describe('isDuckDuckGoAnomalyPage', () => {
  it('detects DDG bot-challenge response', () => {
    const html = '<form id="challenge-form" action="//duckduckgo.com/anomaly.js?...">'
    expect(isDuckDuckGoAnomalyPage(html)).toBe(true)
  })

  it('returns false for a normal results page', () => {
    expect(isDuckDuckGoAnomalyPage('<div class="result">…</div>')).toBe(false)
  })
})

describe('parseBraveJson', () => {
  it('extracts {title, url, description} from web.results', () => {
    const json = {
      web: {
        results: [
          { title: 'A', url: 'https://a.example/', description: 'one' },
          { title: 'B', url: 'https://b.example/' },
          { title: '', url: 'https://nope/' }, // dropped (empty title)
        ],
      },
    }
    expect(parseBraveJson(json)).toEqual([
      { title: 'A', url: 'https://a.example/', snippet: 'one' },
      { title: 'B', url: 'https://b.example/' },
    ])
  })

  it('returns [] for malformed input', () => {
    expect(parseBraveJson(null)).toEqual([])
    expect(parseBraveJson({})).toEqual([])
    expect(parseBraveJson({ web: 'nope' })).toEqual([])
    expect(parseBraveJson({ web: { results: 'nope' } })).toEqual([])
  })
})

describe('parseBaiduJson', () => {
  it('extracts {title,url,snippet} from references[]', () => {
    const json = {
      references: [
        { title: 'A', url: 'https://a.example/', snippet: 'one' },
        { title: 'B', url: 'https://b.example/' }, // snippet absent
        { title: 'C', url: 'https://c.example/', content: 'long content' }, // some plans use `content`
        { title: '', url: 'https://nope/' }, // dropped (empty title)
        { url: 'https://nope2/' }, // dropped (no title)
      ],
    }
    expect(parseBaiduJson(json)).toEqual([
      { title: 'A', url: 'https://a.example/', snippet: 'one' },
      { title: 'B', url: 'https://b.example/' },
      { title: 'C', url: 'https://c.example/', snippet: 'long content' },
    ])
  })

  it('returns [] for malformed input', () => {
    expect(parseBaiduJson(null)).toEqual([])
    expect(parseBaiduJson({})).toEqual([])
    expect(parseBaiduJson({ references: 'nope' })).toEqual([])
  })
})
