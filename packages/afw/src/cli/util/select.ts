// Interactive arrow-key selection for the terminal. Renders a live list the
// user moves through with ↑/↓ (or j/k), picks with Enter, and — in multi mode —
// toggles with Space / `a`. Falls back to returning null when raw-mode keypress
// reading isn't available (non-TTY, or a stdin without setRawMode), so callers
// can drop to a plain numbered prompt instead.

import process from 'node:process'

const ESC = '\x1b'

type SelectOpts = {
  multi?: boolean
  /** Pre-checked indices (multi mode only). */
  preselected?: Iterable<number>
}

/** Drive an interactive selection over `labels`. Returns the chosen 0-based
 *  indices (length 1 in single mode), or null when an interactive UI can't be
 *  shown. Ctrl-C exits the process (130), matching the rest of the CLI prompts. */
export async function interactiveSelect(
  question: string,
  labels: readonly string[],
  opts: SelectOpts = {},
): Promise<number[] | null> {
  const stdin = process.stdin
  const stdout = process.stdout
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function' || labels.length === 0) {
    return null
  }
  const multi = opts.multi === true
  let cursor = 0
  const selected = new Set<number>(opts.preselected ?? [])

  const hint = multi
    ? '↑/↓ move · space toggle · a all · enter confirm'
    : '↑/↓ move · enter select'

  const draw = (first: boolean): void => {
    const lines = labels.map((label, i) => {
      const pointer = i === cursor ? '❯' : ' '
      const box = multi ? (selected.has(i) ? '◉ ' : '◯ ') : ''
      const text = `${pointer} ${box}${label}`
      // Highlight the row under the cursor (cyan).
      return i === cursor ? `${ESC}[36m${text}${ESC}[0m` : text
    })
    if (!first) stdout.write(`${ESC}[${labels.length}A`) // back to the first row
    stdout.write(`${ESC}[J`) // clear from cursor to end of screen
    stdout.write(`${lines.join('\r\n')}\r\n`)
  }

  stdout.write(`${question}  ${ESC}[2m${hint}${ESC}[0m\r\n`)
  stdout.write(`${ESC}[?25l`) // hide cursor
  draw(true)

  return new Promise<number[] | null>((resolve) => {
    const cleanup = (): void => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      stdout.write(`${ESC}[?25h`) // restore cursor
    }
    const finish = (result: number[]): void => {
      cleanup()
      stdout.write('\r\n')
      resolve(result)
    }
    const onData = (chunk: string): void => {
      if (chunk === '') {
        // Ctrl-C
        cleanup()
        stdout.write('\r\n')
        process.exit(130)
      }
      if (chunk === '\r' || chunk === '\n') {
        finish(multi ? [...selected].sort((a, b) => a - b) : [cursor])
        return
      }
      if (chunk === `${ESC}[A` || chunk === 'k') {
        cursor = (cursor - 1 + labels.length) % labels.length
        draw(false)
        return
      }
      if (chunk === `${ESC}[B` || chunk === 'j') {
        cursor = (cursor + 1) % labels.length
        draw(false)
        return
      }
      if (multi && chunk === ' ') {
        if (selected.has(cursor)) selected.delete(cursor)
        else selected.add(cursor)
        draw(false)
        return
      }
      if (multi && (chunk === 'a' || chunk === 'A')) {
        if (selected.size === labels.length) selected.clear()
        else for (let i = 0; i < labels.length; i++) selected.add(i)
        draw(false)
      }
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    stdin.on('data', onData)
  })
}
