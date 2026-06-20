// Best-effort "open this URL in the default browser" for the OAuth login flow.
// Never throws — when no opener is available (headless box, SSH) the caller
// falls back to printing the URL for the user to open by hand.

import { spawn } from 'node:child_process'
import process from 'node:process'

export function openBrowser(url: string): void {
  const platform = process.platform
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // ignored — caller prints the URL as a manual fallback
  }
}
