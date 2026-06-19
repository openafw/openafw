// Surgical unwire: reverse-replay the edits afw recorded in a backup
// entry, instead of overwriting the whole file from a snapshot.
//
// Why: agents legitimately rewrite their own config after wiring (Codex
// continuously updates the `projects` table in config.toml), so a
// whole-file restore guarded by a sha256 match either fails outright or
// clobbers the agent's own changes. Reverse-replay touches only the
// pointers afw wrote, and skips any pointer whose current value no
// longer matches what afw wrote (the agent or user changed it since).

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { YAMLMap, YAMLSeq, isMap, parseDocument } from 'yaml'
import type { Document } from 'yaml'
import type { AgentId } from '../../core/agent.ts'
import { type BackupEntry, type ChangeRecord, MANIFEST_VERSION } from '../../core/manifest.ts'
import { applyJsonUpdate, getValueAt, parseTree, removeJsonPath } from '../rewrite/jsonc.ts'
import {
  deleteTomlKey,
  deleteTomlSection,
  deleteTomlTopLevelKey,
  getTomlString,
  getTomlTopLevelString,
  setTomlString,
  setTomlTopLevelString,
} from '../rewrite/toml.ts'
import { atomicWrite, backupCopy, fileExists } from './files.ts'

export type SkippedChange = { pointer: string; reason: string }

export type RevertResult = {
  /** 'replay' = surgical reverse-replay; 'whole-file' = snapshot restore. */
  mode: 'replay' | 'whole-file' | 'noop'
  reverted: number
  skipped: SkippedChange[]
}

export type UnwireReport = { skipped: SkippedChange[] }

export type RevertOptions = { force?: boolean }

type Format = 'toml' | 'yaml' | 'json'

function formatOf(path: string): Format {
  const ext = extname(path).toLowerCase()
  if (ext === '.toml') return 'toml'
  if (ext === '.yaml' || ext === '.yml') return 'yaml'
  return 'json'
}

function ptrSegs(pointer: string): string[] {
  return pointer.split('/').filter(Boolean)
}

/** A format-preserving editor over one config file. */
interface FileEditor {
  /** Current value at the pointer, or undefined when absent. */
  get(segments: string[]): unknown
  set(segments: string[], value: unknown): void
  remove(segments: string[]): void
  /** Undo a container wire created (whole section / delete-if-empty). */
  removeCreatedPath(segments: string[]): void
  toString(): string
}

class TomlEditor implements FileEditor {
  constructor(private text: string) {}

  get(segs: string[]): unknown {
    if (segs.length === 1) return getTomlTopLevelString(this.text, segs[0]!)
    return getTomlString(this.text, segs.slice(0, -1).join('.'), segs[segs.length - 1]!)
  }

  set(segs: string[], value: unknown): void {
    if (typeof value !== 'string') {
      throw new Error(`TOML revert expects a string value, got ${typeof value}`)
    }
    this.text =
      segs.length === 1
        ? setTomlTopLevelString(this.text, segs[0]!, value).text
        : setTomlString(this.text, segs.slice(0, -1).join('.'), segs[segs.length - 1]!, value).text
  }

  remove(segs: string[]): void {
    this.text =
      segs.length === 1
        ? deleteTomlTopLevelKey(this.text, segs[0]!)
        : deleteTomlKey(this.text, segs.slice(0, -1).join('.'), segs[segs.length - 1]!)
  }

  removeCreatedPath(segs: string[]): void {
    // afw owns its provider id, so the whole section it created is ours
    // to remove — no emptiness check needed.
    this.text = deleteTomlSection(this.text, segs.join('.'))
  }

  toString(): string {
    return this.text
  }
}

class JsonEditor implements FileEditor {
  constructor(private text: string) {}

  get(segs: string[]): unknown {
    const tree = parseTree(this.text)
    return tree ? getValueAt(tree, segs) : undefined
  }

  set(segs: string[], value: unknown): void {
    this.text = applyJsonUpdate(this.text, segs, value)
  }

  remove(segs: string[]): void {
    this.text = removeJsonPath(this.text, segs)
  }

  removeCreatedPath(segs: string[]): void {
    const value = this.get(segs)
    if (value !== null && typeof value === 'object' && Object.keys(value as object).length === 0) {
      this.remove(segs)
    }
  }

  toString(): string {
    return this.text
  }
}

class YamlEditor implements FileEditor {
  private doc: Document.Parsed

  constructor(text: string) {
    this.doc = parseDocument(text)
  }

  // Resolve a logical pointer to a concrete yaml path. `custom_providers`
  // is a sequence of {name, ...} maps, not a name-keyed map, so a
  // non-numeric segment under a sequence is matched against item `name`.
  private resolve(segs: string[]): (string | number)[] | undefined {
    const out: (string | number)[] = []
    let node: unknown = this.doc.contents
    for (const seg of segs) {
      if (node instanceof YAMLSeq) {
        const num = Number(seg)
        if (Number.isInteger(num) && String(num) === seg) {
          out.push(num)
          node = node.items[num]
        } else {
          const idx = node.items.findIndex((it) => it instanceof YAMLMap && it.get('name') === seg)
          if (idx < 0) return undefined
          out.push(idx)
          node = node.items[idx]
        }
      } else if (node instanceof YAMLMap) {
        out.push(seg)
        node = node.get(seg, true)
      } else {
        return undefined
      }
    }
    return out
  }

  get(segs: string[]): unknown {
    const path = this.resolve(segs)
    if (!path) return undefined
    return this.doc.getIn(path)
  }

  set(segs: string[], value: unknown): void {
    const path = this.resolve(segs)
    if (!path) throw new Error(`yaml path not resolvable: /${segs.join('/')}`)
    this.doc.setIn(path, value)
  }

  remove(segs: string[]): void {
    const path = this.resolve(segs)
    if (path) this.doc.deleteIn(path)
  }

  removeCreatedPath(segs: string[]): void {
    const path = this.resolve(segs)
    if (!path) return
    const node = this.doc.getIn(path, true)
    if (isMap(node) && node.items.length === 0) this.doc.deleteIn(path)
  }

  toString(): string {
    return this.doc.toString({ lineWidth: 0 })
  }
}

function makeEditor(text: string, fmt: Format): FileEditor {
  if (fmt === 'toml') return new TomlEditor(text)
  if (fmt === 'yaml') return new YamlEditor(text)
  return new JsonEditor(text)
}

// claude-code stores MCP servers under `mcpServers`; hermes under
// `mcp_servers`. wrap-mcp records the name only — derive the parent key.
function mcpParentKey(agent: AgentId): string {
  return agent === 'hermes' ? 'mcp_servers' : 'mcpServers'
}

/** Verify the pointer's current value still matches what wire wrote.
 *  Primitives use strict equality; arrays/objects fall back to a JSON
 *  round-trip — good enough for the JSON / JSON5 configs afw writes,
 *  where the contents are always JSON-serialisable. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}

function replay(
  editor: FileEditor,
  changes: ChangeRecord[],
  agent: AgentId,
): { reverted: number; skipped: SkippedChange[] } {
  const skipped: SkippedChange[] = []
  let reverted = 0

  // Reverse order: the last edit wire made is the first one undone.
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i]!
    if (c.type === 'set') {
      const segs = ptrSegs(c.jsonPointer)
      const current = editor.get(segs)
      if (!sameValue(current, c.to)) {
        skipped.push({ pointer: c.jsonPointer, reason: 'changed after wiring' })
        continue
      }
      if (c.fromAbsent) editor.remove(segs)
      else editor.set(segs, c.from)
      reverted++
    } else if (c.type === 'create-path') {
      editor.removeCreatedPath(ptrSegs(c.jsonPointer))
      reverted++
    } else if (c.type === 'wrap-mcp') {
      const parent = mcpParentKey(agent)
      const cmdSegs = [parent, c.name, 'command']
      if (editor.get(cmdSegs) !== c.to.command) {
        skipped.push({ pointer: `/${parent}/${c.name}`, reason: 'changed after wiring' })
        continue
      }
      if (c.from.command === undefined) editor.remove(cmdSegs)
      else editor.set(cmdSegs, c.from.command)
      const argSegs = [parent, c.name, 'args']
      if (c.from.args === undefined) editor.remove(argSegs)
      else editor.set(argSegs, c.from.args)
      reverted++
    } else if (c.type === 'env-inject') {
      // No detector emits env-inject; there is no .env editor primitive.
      skipped.push({ pointer: `env:${c.key}`, reason: 'env-inject revert unsupported' })
    }
  }
  return { reverted, skipped }
}

async function wholeFileRestore(entry: BackupEntry): Promise<RevertResult> {
  if (!(await fileExists(entry.backupPath))) {
    return {
      mode: 'whole-file',
      reverted: 0,
      skipped: [{ pointer: entry.originalPath, reason: 'backup snapshot missing' }],
    }
  }
  await backupCopy(entry.backupPath, entry.originalPath)
  return { mode: 'whole-file', reverted: entry.changes.length, skipped: [] }
}

/**
 * Revert one backup entry. v2 entries are reverse-replayed surgically;
 * legacy entries (and `--force`) fall back to a whole-file snapshot
 * restore. Never throws on expected conditions — a missing original file
 * or backup is reported in `skipped`.
 */
export async function revertEntry(entry: BackupEntry, opts?: RevertOptions): Promise<RevertResult> {
  if (!(await fileExists(entry.originalPath))) {
    return {
      mode: 'noop',
      reverted: 0,
      skipped: [{ pointer: entry.originalPath, reason: 'original file no longer exists' }],
    }
  }

  const legacy = entry.manifestVersion !== MANIFEST_VERSION || entry.changes.length === 0
  if (opts?.force || legacy) {
    return wholeFileRestore(entry)
  }

  const text = await readFile(entry.originalPath, 'utf8')
  const editor = makeEditor(text, formatOf(entry.originalPath))
  const { reverted, skipped } = replay(editor, entry.changes, entry.agent)
  await atomicWrite(entry.originalPath, editor.toString())
  return { mode: 'replay', reverted, skipped }
}

/**
 * Revert every backup entry for `agent`, aggregating the skipped pointers
 * so the caller can report what the agent changed after wiring.
 */
export async function revertEntries(
  entries: BackupEntry[],
  agent: AgentId,
  opts?: RevertOptions,
): Promise<UnwireReport> {
  const skipped: SkippedChange[] = []
  for (const entry of entries) {
    if (entry.agent !== agent) continue
    const r = await revertEntry(entry, opts)
    skipped.push(...r.skipped)
  }
  return { skipped }
}
