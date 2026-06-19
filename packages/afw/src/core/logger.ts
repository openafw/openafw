import process from 'node:process'

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'

const LEVELS: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}

function envLevel(): LogLevel {
  const v = process.env.AFW_LOG_LEVEL as LogLevel | undefined
  if (v && v in LEVELS) return v
  return 'info'
}

let currentLevel = LEVELS[envLevel()]

export const logger = {
  setLevel(level: LogLevel): void {
    currentLevel = LEVELS[level]
  },

  error(...args: unknown[]): void {
    if (currentLevel >= LEVELS.error) process.stderr.write(`${format('error', args)}\n`)
  },
  warn(...args: unknown[]): void {
    if (currentLevel >= LEVELS.warn) process.stderr.write(`${format('warn', args)}\n`)
  },
  info(...args: unknown[]): void {
    if (currentLevel >= LEVELS.info) process.stdout.write(`${format('info', args)}\n`)
  },
  debug(...args: unknown[]): void {
    if (currentLevel >= LEVELS.debug) process.stdout.write(`${format('debug', args)}\n`)
  },

  // Plain user-facing output (no level prefix, no leveling). Goes to stdout
  // so it composes with shell pipelines.
  print(s: string): void {
    process.stdout.write(`${s}\n`)
  },
}

function format(level: string, args: unknown[]): string {
  return `[${level}] ${args.map(formatArg).join(' ')}`
}

function formatArg(a: unknown): string {
  if (typeof a === 'string') return a
  try {
    return JSON.stringify(a)
  } catch {
    return String(a)
  }
}
