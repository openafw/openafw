import { describe, expect, it } from 'vitest'
import { parseJsonc, removeJsonPath } from './jsonc.ts'

describe('removeJsonPath', () => {
  it('removes a nested key, preserving comments and formatting', () => {
    const src = `{
  // user comment
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:9877/wire/claude-code/anthropic",
    "KEEP_ME": "yes"
  }
}
`
    const out = removeJsonPath(src, ['env', 'ANTHROPIC_BASE_URL'])
    expect(out).toContain('// user comment')
    expect(out).toContain('"KEEP_ME": "yes"')
    expect(out).not.toContain('ANTHROPIC_BASE_URL')
    expect(parseJsonc(out)).toEqual({ env: { KEEP_ME: 'yes' } })
  })

  it('removes a whole object when its only key is targeted', () => {
    const src = '{\n  "env": {\n    "ONLY": "x"\n  }\n}\n'
    const after = removeJsonPath(src, ['env', 'ONLY'])
    expect(parseJsonc(after)).toEqual({ env: {} })
    const empty = removeJsonPath(after, ['env'])
    expect(parseJsonc(empty)).toEqual({})
  })

  it('is a no-op when the path is absent', () => {
    const src = '{\n  "a": 1\n}\n'
    expect(parseJsonc(removeJsonPath(src, ['missing']))).toEqual({ a: 1 })
  })
})
