import { describe, expect, it } from 'vitest'
import {
  deleteTomlKey,
  deleteTomlSection,
  deleteTomlTopLevelKey,
  getTomlString,
  getTomlTopLevelString,
} from './toml.ts'

describe('deleteTomlTopLevelKey', () => {
  it('removes the matching top-level assignment, preserves the rest', () => {
    const src = '# header comment\nmodel = "gpt-5"\nmodel_provider = "agentfw"\n\n[projects]\n'
    const out = deleteTomlTopLevelKey(src, 'model_provider')
    expect(out).toBe('# header comment\nmodel = "gpt-5"\n\n[projects]\n')
    expect(getTomlTopLevelString(out, 'model_provider')).toBeUndefined()
    expect(getTomlTopLevelString(out, 'model')).toBe('gpt-5')
  })

  it('is a no-op when the key is absent', () => {
    const src = 'model = "gpt-5"\n\n[projects]\nfoo = "bar"\n'
    expect(deleteTomlTopLevelKey(src, 'model_provider')).toBe(src)
  })

  it('does not touch a same-named key inside a section', () => {
    const src = 'model = "gpt-5"\n\n[section]\nmodel = "other"\n'
    expect(deleteTomlTopLevelKey(src, 'model')).toBe('\n[section]\nmodel = "other"\n')
  })
})

describe('deleteTomlKey', () => {
  it('removes one section key, keeps comments and siblings', () => {
    const src =
      '[model_providers.agentfw]\n# our provider\nname = "agentfw"\nbase_url = "http://x"\n'
    const out = deleteTomlKey(src, 'model_providers.agentfw', 'base_url')
    expect(out).toBe('[model_providers.agentfw]\n# our provider\nname = "agentfw"\n')
    expect(getTomlString(out, 'model_providers.agentfw', 'base_url')).toBeUndefined()
    expect(getTomlString(out, 'model_providers.agentfw', 'name')).toBe('agentfw')
  })

  it('is a no-op when section or key is absent', () => {
    const src = '[a]\nx = "1"\n'
    expect(deleteTomlKey(src, 'a', 'missing')).toBe(src)
    expect(deleteTomlKey(src, 'nope', 'x')).toBe(src)
  })
})

describe('deleteTomlSection', () => {
  it('removes header + body + one blank separator above, keeps later sections', () => {
    const src =
      'model = "gpt-5"\n\n[model_providers.agentfw]\nname = "agentfw"\nbase_url = "http://x"\n\n[projects]\nfoo = "bar"\n'
    const out = deleteTomlSection(src, 'model_providers.agentfw')
    expect(out).toBe('model = "gpt-5"\n[projects]\nfoo = "bar"\n')
    expect(getTomlString(out, 'projects', 'foo')).toBe('bar')
  })

  it('keeps a comment line that sits directly above the header', () => {
    const src = '# keep me\n[model_providers.agentfw]\nname = "agentfw"\n\n[projects]\nx = "1"\n'
    const out = deleteTomlSection(src, 'model_providers.agentfw')
    expect(out).toBe('# keep me\n[projects]\nx = "1"\n')
  })

  it('is a no-op when the section is absent', () => {
    const src = '[projects]\nfoo = "bar"\n'
    expect(deleteTomlSection(src, 'model_providers.agentfw')).toBe(src)
  })
})
