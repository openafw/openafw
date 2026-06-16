import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveLaunchBin } from './resolve-bin.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentfw-launch-bin-'))
})

afterEach(async () => {
  await import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true, force: true }))
})

describe('resolveLaunchBin', () => {
  it('prefers a Windows executable over npm shell shims', async () => {
    await writeFile(join(dir, 'claude'), '#!/bin/sh\nexit 1\n')
    await writeFile(join(dir, 'claude.cmd'), '@echo off\r\nexit /b 1\r\n')
    await writeFile(join(dir, 'claude.exe'), '')

    const resolved = await resolveLaunchBin('claude', {
      env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      platform: 'win32',
    })

    expect(resolved).toEqual({ argsPrefix: [], command: join(dir, 'claude.exe'), shell: false })
  })

  it('resolves npm cmd shims to their native executable targets', async () => {
    await writeFile(join(dir, 'claude'), '#!/bin/sh\nexit 1\n')
    await mkdir(join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin'), {
      recursive: true,
    })
    const target = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    await writeFile(target, '')
    await writeFile(
      join(dir, 'claude.cmd'),
      '@echo off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n',
    )

    const resolved = await resolveLaunchBin('claude', {
      env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      platform: 'win32',
    })

    expect(resolved).toEqual({ argsPrefix: [], command: target, shell: false })
  })

  it('resolves npm cmd shims to node script invocations', async () => {
    await mkdir(join(dir, 'node_modules', '@openai', 'codex', 'bin'), {
      recursive: true,
    })
    const script = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    await writeFile(script, '')
    await writeFile(
      join(dir, 'codex.cmd'),
      '@echo off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
    )

    const resolved = await resolveLaunchBin('codex', {
      env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      platform: 'win32',
    })

    expect(resolved).toEqual({ argsPrefix: [script], command: process.execPath, shell: false })
  })

  it('runs opaque Windows cmd shims through the shell when no target is discoverable', async () => {
    await writeFile(join(dir, 'claude'), '#!/bin/sh\nexit 1\n')
    await writeFile(join(dir, 'claude.cmd'), '@echo off\r\nexit /b 0\r\n')

    const resolved = await resolveLaunchBin('claude', {
      env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      platform: 'win32',
    })

    expect(resolved).toEqual({ argsPrefix: [], command: join(dir, 'claude.cmd'), shell: true })
  })

  it('uses PATH entries case-insensitively on Windows', async () => {
    const nested = join(dir, 'Bin')
    await mkdir(nested)
    await writeFile(join(nested, 'claude.CMD'), '@echo off\r\nexit /b 0\r\n')

    const resolved = await resolveLaunchBin('claude', {
      env: { Path: `${dir}${delimiter}${nested}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      platform: 'win32',
    })

    expect(resolved.command.toLowerCase()).toBe(join(nested, 'claude.cmd').toLowerCase())
    expect(resolved.argsPrefix).toEqual([])
    expect(resolved.shell).toBe(true)
  })

  it('leaves POSIX command lookup to spawn', async () => {
    const resolved = await resolveLaunchBin('claude', {
      env: { PATH: dir },
      platform: 'linux',
    })

    expect(resolved).toEqual({ argsPrefix: [], command: 'claude', shell: false })
  })
})
