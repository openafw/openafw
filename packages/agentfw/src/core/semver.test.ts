import { describe, expect, it } from 'vitest'
import { compareVersions, isNewer, parseVersion } from './semver.ts'

describe('parseVersion', () => {
  it('parses plain and v-prefixed versions', () => {
    expect(parseVersion('0.3.0')).toEqual({ major: 0, minor: 3, patch: 0, pre: '' })
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: '' })
    expect(parseVersion('0.4.0-beta.1')?.pre).toBe('beta.1')
  })

  it('returns null for garbage', () => {
    expect(parseVersion('not-a-version')).toBeNull()
    expect(parseVersion('1.2')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders by major, minor, patch', () => {
    expect(compareVersions('0.3.0', '0.4.0')).toBe(-1)
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.3.1', '0.3.1')).toBe(0)
    expect(compareVersions('0.3.10', '0.3.9')).toBe(1)
  })

  it('ranks a real release above its prerelease', () => {
    expect(compareVersions('0.4.0', '0.4.0-beta')).toBe(1)
    expect(compareVersions('0.4.0-beta', '0.4.0')).toBe(-1)
  })

  it('treats unparseable input as equal (never a false update signal)', () => {
    expect(compareVersions('garbage', '0.3.0')).toBe(0)
  })
})

describe('isNewer', () => {
  it('is true only when latest strictly exceeds current', () => {
    expect(isNewer('0.4.0', '0.3.0')).toBe(true)
    expect(isNewer('0.3.0', '0.3.0')).toBe(false)
    expect(isNewer('0.2.0', '0.3.0')).toBe(false)
  })
})
