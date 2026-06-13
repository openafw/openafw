import { createInterface } from 'node:readline/promises'
import process from 'node:process'

/**
 * Ask a yes/no question on the terminal. Returns `defaultYes` on empty input
 * or when not attached to a TTY (so non-interactive runs never block).
 */
export async function confirmYesNo(
  question: string,
  defaultYes = true,
): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const hint = defaultYes ? '[Y/n]' : '[y/N]'
    const answer = (await rl.question(`${question} ${hint} `)).trim().toLowerCase()
    if (answer === '') return defaultYes
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

/**
 * Ask for a line of text. Returns the trimmed answer, or `def` on empty input.
 * Non-interactive (no TTY) returns `def` so scripted runs never block.
 */
export async function promptText(question: string, def = ''): Promise<string> {
  if (!process.stdin.isTTY) return def
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const hint = def ? ` (${def})` : ''
    const answer = (await rl.question(`${question}${hint}: `)).trim()
    return answer === '' ? def : answer
  } finally {
    rl.close()
  }
}

/**
 * Ask the user to pick one of `choices`. Returns the chosen value. The first
 * choice is the default (selected on empty input or no TTY).
 */
export async function promptChoice<T extends string>(
  question: string,
  choices: readonly T[],
): Promise<T> {
  const first = choices[0] as T
  if (!process.stdin.isTTY) return first
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const list = choices.map((c, i) => `  ${i + 1}) ${c}`).join('\n')
      const answer = (await rl.question(`${question}\n${list}\n[1] `)).trim()
      if (answer === '') return first
      const byIndex = Number.parseInt(answer, 10)
      if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= choices.length) {
        return choices[byIndex - 1] as T
      }
      const byName = choices.find((c) => c === answer)
      if (byName) return byName
    }
  } finally {
    rl.close()
  }
}

/**
 * Read a secret from the terminal without echoing keystrokes. Falls back to a
 * plain line read when stdin is not a TTY, so a piped value still works.
 */
export async function promptSecret(question: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin })
    try {
      for await (const line of rl) return line
      return ''
    } finally {
      rl.close()
    }
  }
  process.stdout.write(question)
  return new Promise<string>((resolve) => {
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === '') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.removeListener('data', onData)
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (ch === '') {
          stdin.setRawMode(false)
          process.stdout.write('\n')
          process.exit(130)
        }
        if (ch === '' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on('data', onData)
  })
}
