// Line-based TOML editor that preserves byte-exact formatting outside the
// edits it makes. Not a general TOML parser — just enough to:
//   • read the current value of `<section>.<key>` (returning undefined if
//     missing), and
//   • set `<section>.<key>` to a string value, either by replacing an
//     existing line or by inserting it under the section header (or
//     appending the whole [section] + key=value block at EOF when neither
//     exists).
//
// The "section" string may be dotted (e.g. "model_providers.openai") and
// is matched against the literal `[section]` header. The "key" must be a
// bare identifier (no dots).

const HEADER_RE = /^\s*\[([^\]]+)\]\s*$/
const ASSIGN_RE = /^\s*([A-Za-z_][\w-]*)\s*=/

function isHeaderLine(line: string): boolean {
  return HEADER_RE.test(line)
}

function headerName(line: string): string | null {
  const m = HEADER_RE.exec(line)
  return m && m[1] ? m[1].trim() : null
}

function tomlEscape(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function parseTomlString(rhs: string): string | null {
  const trimmed = rhs.trim().replace(/\s*#.*$/, '').trim()
  // Basic string forms: "..."  '...'
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // Fall through
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }
  return null
}

export function getTomlString(
  text: string,
  section: string,
  key: string,
): string | undefined {
  const lines = text.split('\n')
  let inSection = false
  for (const raw of lines) {
    if (isHeaderLine(raw)) {
      inSection = headerName(raw) === section
      continue
    }
    if (!inSection) continue
    const m = ASSIGN_RE.exec(raw)
    if (!m || m[1] !== key) continue
    const rhs = raw.slice(raw.indexOf('=') + 1)
    const value = parseTomlString(rhs)
    if (value != null) return value
  }
  return undefined
}

export type SetTomlResult = {
  text: string
  /** true when [section] didn't exist before and we appended a block. */
  sectionAdded: boolean
  /** true when the key line was inserted vs replaced. */
  keyAdded: boolean
}

/**
 * Read the value of a top-level key (above the first [section] header).
 */
export function getTomlTopLevelString(text: string, key: string): string | undefined {
  const lines = text.split('\n')
  for (const raw of lines) {
    if (isHeaderLine(raw)) return undefined
    const m = ASSIGN_RE.exec(raw)
    if (!m || m[1] !== key) continue
    const rhs = raw.slice(raw.indexOf('=') + 1)
    const value = parseTomlString(rhs)
    if (value != null) return value
  }
  return undefined
}

/**
 * Set a top-level key (above the first [section] header). If the key
 * exists at the top level, replace its line in place. Otherwise insert
 * it at the very top of the file, preserving everything else.
 */
export function setTomlTopLevelString(
  text: string,
  key: string,
  value: string,
): SetTomlResult {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    if (isHeaderLine(raw)) break
    const m = ASSIGN_RE.exec(raw)
    if (m && m[1] === key) {
      lines[i] = `${key} = ${tomlEscape(value)}`
      return { text: lines.join('\n'), sectionAdded: false, keyAdded: false }
    }
  }
  // Not present at top level — prepend a new line. Add a blank line
  // separator before any existing [section] header so the new top-level
  // assignment isn't visually glued to the next section.
  const newLine = `${key} = ${tomlEscape(value)}`
  if (text.length === 0) {
    return { text: `${newLine}\n`, sectionAdded: false, keyAdded: true }
  }
  const sep = isHeaderLine(text.split('\n', 1)[0] ?? '') ? '\n\n' : '\n'
  return { text: `${newLine}${sep}${text}`, sectionAdded: false, keyAdded: true }
}

export function setTomlString(
  text: string,
  section: string,
  key: string,
  value: string,
): SetTomlResult {
  const lines = text.split('\n')
  let sectionStart = -1
  let keyLine = -1
  let inSection = false

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    if (isHeaderLine(raw)) {
      const name = headerName(raw)
      if (name === section) {
        inSection = true
        sectionStart = i
        continue
      }
      if (inSection) break // entered a new section after ours
      inSection = false
      continue
    }
    if (!inSection) continue
    const m = ASSIGN_RE.exec(raw)
    if (m && m[1] === key) {
      keyLine = i
      break
    }
  }

  const newKeyLine = `${key} = ${tomlEscape(value)}`

  if (keyLine >= 0) {
    lines[keyLine] = newKeyLine
    return { text: lines.join('\n'), sectionAdded: false, keyAdded: false }
  }

  if (sectionStart >= 0) {
    // Insert directly after the section header (skip any blank line gap).
    let insertAt = sectionStart + 1
    while (insertAt < lines.length && lines[insertAt]!.trim() === '') insertAt++
    lines.splice(insertAt, 0, newKeyLine)
    return { text: lines.join('\n'), sectionAdded: false, keyAdded: true }
  }

  // Section doesn't exist — append a new block at EOF.
  const needsLeadingBlank = text.length > 0 && !text.endsWith('\n\n')
  const prefix = text.length > 0 && !text.endsWith('\n') ? '\n' : ''
  const blank = needsLeadingBlank ? '\n' : ''
  return {
    text: `${text}${prefix}${blank}[${section}]\n${newKeyLine}\n`,
    sectionAdded: true,
    keyAdded: true,
  }
}

/**
 * Either a string (which will be quoted as a TOML string) or a raw TOML
 * literal (`{ raw: 'true' }` for a boolean, `{ raw: '42' }` for a number,
 * etc.). Anything in `raw` is inserted verbatim — caller's responsibility
 * to keep it valid.
 */
export type TomlValue = string | { raw: string }

function tomlSerialize(v: TomlValue): string {
  if (typeof v === 'string') return tomlEscape(v)
  return v.raw
}

export type TomlBlock = Record<string, TomlValue>

/**
 * Same shape as setTomlString but accepts string or raw values so the
 * caller can write booleans/numbers without string quoting.
 */
export function setTomlValue(
  text: string,
  section: string,
  key: string,
  value: TomlValue,
): SetTomlResult {
  const lines = text.split('\n')
  let sectionStart = -1
  let keyLine = -1
  let inSection = false

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    if (isHeaderLine(raw)) {
      const name = headerName(raw)
      if (name === section) {
        inSection = true
        sectionStart = i
        continue
      }
      if (inSection) break
      inSection = false
      continue
    }
    if (!inSection) continue
    const m = ASSIGN_RE.exec(raw)
    if (m && m[1] === key) {
      keyLine = i
      break
    }
  }

  const newKeyLine = `${key} = ${tomlSerialize(value)}`

  if (keyLine >= 0) {
    lines[keyLine] = newKeyLine
    return { text: lines.join('\n'), sectionAdded: false, keyAdded: false }
  }

  if (sectionStart >= 0) {
    let insertAt = sectionStart + 1
    while (insertAt < lines.length && lines[insertAt]!.trim() === '') insertAt++
    lines.splice(insertAt, 0, newKeyLine)
    return { text: lines.join('\n'), sectionAdded: false, keyAdded: true }
  }

  const needsLeadingBlank = text.length > 0 && !text.endsWith('\n\n')
  const prefix = text.length > 0 && !text.endsWith('\n') ? '\n' : ''
  const blank = needsLeadingBlank ? '\n' : ''
  return {
    text: `${text}${prefix}${blank}[${section}]\n${newKeyLine}\n`,
    sectionAdded: true,
    keyAdded: true,
  }
}

/**
 * Delete a top-level key (above the first [section] header). Returns the
 * text unchanged when the key is absent. Surrounding lines are untouched.
 */
export function deleteTomlTopLevelKey(text: string, key: string): string {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    if (isHeaderLine(raw)) break
    const m = ASSIGN_RE.exec(raw)
    if (m && m[1] === key) {
      lines.splice(i, 1)
      return lines.join('\n')
    }
  }
  return text
}

/**
 * Delete `<section>.<key>`. Returns the text unchanged when the section or
 * key is absent. Only the matching assignment line is removed.
 */
export function deleteTomlKey(text: string, section: string, key: string): string {
  const lines = text.split('\n')
  let inSection = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    if (isHeaderLine(raw)) {
      const name = headerName(raw)
      if (name === section) {
        inSection = true
        continue
      }
      if (inSection) break
      inSection = false
      continue
    }
    if (!inSection) continue
    const m = ASSIGN_RE.exec(raw)
    if (m && m[1] === key) {
      lines.splice(i, 1)
      return lines.join('\n')
    }
  }
  return text
}

/**
 * Delete an entire `[section]` — its header and every line until the next
 * header or EOF, plus one blank separator line immediately above it (the
 * separator `setTomlValue` inserts when it appends a fresh section).
 * Returns the text unchanged when the section is absent.
 */
export function deleteTomlSection(text: string, section: string): string {
  const lines = text.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (isHeaderLine(lines[i]!) && headerName(lines[i]!) === section) {
      start = i
      break
    }
  }
  if (start < 0) return text
  let end = start + 1
  while (end < lines.length && !isHeaderLine(lines[end]!)) end++
  // Absorb a single blank separator line directly above the header.
  if (start > 0 && lines[start - 1]!.trim() === '') start--
  lines.splice(start, end - start)
  return lines.join('\n')
}

/**
 * Ensure a section exists with the given key=value pairs. Existing keys
 * are replaced; missing keys are inserted under the section header in
 * the given iteration order. Returns the new text plus diagnostics.
 */
export function ensureTomlSection(
  text: string,
  section: string,
  entries: TomlBlock,
): { text: string; addedKeys: string[]; replacedKeys: string[]; sectionAdded: boolean } {
  let current = text
  const added: string[] = []
  const replaced: string[] = []
  let sectionAdded = false
  for (const [k, v] of Object.entries(entries)) {
    const res = setTomlValue(current, section, k, v)
    current = res.text
    if (res.sectionAdded) sectionAdded = true
    if (res.keyAdded) added.push(k)
    else replaced.push(k)
  }
  return { text: current, addedKeys: added, replacedKeys: replaced, sectionAdded }
}
