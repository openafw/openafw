import * as jsonc from 'jsonc-parser'

export type JsoncFormatOptions = {
  insertSpaces: boolean
  tabSize: number
  eol: string
}

/**
 * Best-effort inspection of an existing file's formatting style. Used to keep
 * round-trip edits visually identical to user-authored files.
 */
export function detectFormat(source: string): JsoncFormatOptions {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const indentMatch = source.match(/\n([ \t]+)/)
  if (!indentMatch || indentMatch[1] === undefined) {
    return { insertSpaces: true, tabSize: 2, eol }
  }
  const indent = indentMatch[1]
  if (indent.startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol }
  return { insertSpaces: true, tabSize: indent.length, eol }
}

/**
 * Apply a single JSON path → value update to source text while preserving
 * comments, formatting, and ordering. Uses jsonc-parser's modify().
 */
export function applyJsonUpdate(
  source: string,
  path: jsonc.JSONPath,
  value: unknown,
  format?: JsoncFormatOptions,
): string {
  const opts = format ?? detectFormat(source)
  const edits = jsonc.modify(source, path, value, { formattingOptions: opts })
  return jsonc.applyEdits(source, edits)
}

/**
 * Apply multiple JSON path → value updates in sequence. Each edit re-reads
 * the in-progress text so offsets stay correct.
 */
export function applyJsonUpdates(
  source: string,
  updates: Array<{ path: jsonc.JSONPath; value: unknown }>,
  format?: JsoncFormatOptions,
): string {
  let result = source
  const opts = format ?? detectFormat(source)
  for (const u of updates) {
    result = applyJsonUpdate(result, u.path, u.value, opts)
  }
  return result
}

/**
 * Remove the value at a JSON path while preserving comments, formatting,
 * and ordering. A no-op when the path is absent. Uses jsonc-parser's
 * modify() with an undefined value — its native removal mode.
 */
export function removeJsonPath(
  source: string,
  path: jsonc.JSONPath,
  format?: JsoncFormatOptions,
): string {
  const opts = format ?? detectFormat(source)
  const edits = jsonc.modify(source, path, undefined, { formattingOptions: opts })
  return jsonc.applyEdits(source, edits)
}

/**
 * Tolerant JSON / JSONC parse. Returns undefined on failure; pass `errors`
 * to collect parse errors as a side channel.
 */
export function parseJsonc<T = unknown>(
  source: string,
  errors?: jsonc.ParseError[],
): T | undefined {
  const errs: jsonc.ParseError[] = []
  const result = jsonc.parse(source, errs, { allowTrailingComma: true })
  if (errors) errors.push(...errs)
  if (errs.length > 0) return undefined
  return result as T
}

export function parseTree(source: string): jsonc.Node | undefined {
  return jsonc.parseTree(source)
}

export function getValueAt<T = unknown>(tree: jsonc.Node, path: jsonc.JSONPath): T | undefined {
  const node = jsonc.findNodeAtLocation(tree, path)
  return node ? (jsonc.getNodeValue(node) as T) : undefined
}
