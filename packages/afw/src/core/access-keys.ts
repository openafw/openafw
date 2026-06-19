// afw API keys — ~/.afw/keys.json, file mode 0600. A key is a SHORT
// local identifier that distinguishes one agent (or one agent session) from
// another — it is NOT a security secret (everything is local). afw attributes
// behaviour, routing, and tracking per key.
//
// Each key names the `agent` it represents. Launch-per-task agents (Claude Code,
// Codex) get one key per directory session, auto-minted on `afw claude` /
// `afw codex` and tied to the session `instance`. App/daemon agents
// (OpenClaw, Hermes) get keys minted on demand via `afw openclaw` /
// `afw hermes`, which they then present to the /v1 endpoint.

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { AgentId } from './agent.ts'
import { atomicWrite, fileExists } from './atomic-file.ts'
import { paths } from './paths.ts'

export const ACCESS_KEYS_VERSION = 1 as const
const KEYS_MODE = 0o600

/** Token prefix so a stray value is recognizable as an afw key. */
const TOKEN_PREFIX = 'afw_'
const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const TOKEN_LEN = 6

/** The default agent label for a key created without one (a generic agent). */
export const DEFAULT_AGENT: AgentId = 'byok'

export type AccessKeyEntry = {
  /** Stable short id — used in `afw key rm <id>` and the dashboard. */
  id: string
  label: string
  /** The short token the agent presents / afw tracks behaviour under. */
  token: string
  /** Which agent this key represents (claude-code, codex, openclaw, …). */
  agent: AgentId
  /** Launch-per-task session id (the per-directory instance) — set for the
   *  keys `afw claude` / `codex` auto-mint, absent for app/daemon keys. */
  instance?: string
  createdAt: number
  lastUsedAt?: number
}

export type AccessKeys = {
  version: typeof ACCESS_KEYS_VERSION
  keys: AccessKeyEntry[]
}

export const EMPTY_ACCESS_KEYS: AccessKeys = { version: ACCESS_KEYS_VERSION, keys: [] }

// ── lookup ────────────────────────────────────────────────────────

export function findKeyByToken(store: AccessKeys, token: string): AccessKeyEntry | undefined {
  if (!token) return undefined
  return store.keys.find((k) => k.token === token)
}

export function findKeyById(store: AccessKeys, id: string): AccessKeyEntry | undefined {
  return store.keys.find((k) => k.id === id)
}

/** Every key for one agent. */
export function keysForAgent(store: AccessKeys, agent: AgentId): AccessKeyEntry[] {
  return store.keys.filter((k) => k.agent === agent)
}

/** The key for a launch-per-task agent's directory session, if one exists. */
export function findKeyByAgentInstance(
  store: AccessKeys,
  agent: AgentId,
  instance: string,
): AccessKeyEntry | undefined {
  return store.keys.find((k) => k.agent === agent && k.instance === instance)
}

// ── generators ────────────────────────────────────────────────────

/** Derive a stable, URL-safe id from a label, suffixing -2/-3/… to avoid
 *  colliding with an existing id. Falls back to `key` for label-less input. */
export function deriveKeyId(label: string, taken: Iterable<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'key'
  const set = new Set(taken)
  if (!set.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!set.has(candidate)) return candidate
  }
}

function randToken(): string {
  const bytes = randomBytes(TOKEN_LEN)
  let s = ''
  for (let i = 0; i < TOKEN_LEN; i++) s += TOKEN_ALPHABET[bytes[i]! % TOKEN_ALPHABET.length]
  return `${TOKEN_PREFIX}${s}`
}

/** A fresh short token (e.g. `afw_k7m2qd`), unique against the ones taken.
 *  Short on purpose — these are local agent identifiers, not secrets. */
export function generateToken(taken: Iterable<string> = []): string {
  const set = new Set(taken)
  for (let i = 0; i < 10_000; i++) {
    const t = randToken()
    if (!set.has(t)) return t
  }
  return randToken()
}

// ── parse / normalize ─────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function normalizeEntry(raw: unknown): AccessKeyEntry | undefined {
  if (!isObj(raw)) return undefined
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const token = typeof raw.token === 'string' ? raw.token.trim() : ''
  if (!id || !token) return undefined
  return {
    id,
    label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : id,
    token,
    agent: typeof raw.agent === 'string' && raw.agent !== '' ? raw.agent : DEFAULT_AGENT,
    ...(typeof raw.instance === 'string' && raw.instance !== '' ? { instance: raw.instance } : {}),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    ...(typeof raw.lastUsedAt === 'number' ? { lastUsedAt: raw.lastUsedAt } : {}),
  }
}

export function normalizeAccessKeys(raw: unknown): AccessKeys {
  if (!isObj(raw)) return { ...EMPTY_ACCESS_KEYS }
  if (raw.version !== ACCESS_KEYS_VERSION) {
    throw new Error(
      `keys.json version ${String(raw.version)} not supported (expected ${ACCESS_KEYS_VERSION})`,
    )
  }
  const keys: AccessKeyEntry[] = []
  if (Array.isArray(raw.keys)) {
    for (const entry of raw.keys) {
      const norm = normalizeEntry(entry)
      if (norm) keys.push(norm)
    }
  }
  return { version: ACCESS_KEYS_VERSION, keys }
}

// ── read / write ──────────────────────────────────────────────────

export async function readAccessKeys(): Promise<AccessKeys> {
  if (!(await fileExists(paths.keys))) return { ...EMPTY_ACCESS_KEYS }
  return normalizeAccessKeys(JSON.parse(await readFile(paths.keys, 'utf8')))
}

export async function writeAccessKeys(store: AccessKeys): Promise<void> {
  await atomicWrite(paths.keys, `${JSON.stringify(store, null, 2)}\n`, { mode: KEYS_MODE })
}

let writeChain: Promise<unknown> = Promise.resolve()

/** Serialized read-modify-write — see model-registry.ts mutateModelRegistry. */
export function mutateAccessKeys(
  fn: (store: AccessKeys) => AccessKeys | undefined,
): Promise<AccessKeys> {
  const next = writeChain.then(async () => {
    const store = await readAccessKeys()
    const updated = fn(store)
    if (updated) await writeAccessKeys(updated)
    return updated ?? store
  })
  writeChain = next.catch(() => {})
  return next
}
