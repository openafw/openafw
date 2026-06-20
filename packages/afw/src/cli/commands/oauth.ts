// `afw oauth login <provider>` — run afw's own OAuth subscription login. afw
// is a first-class OAuth client: it stores its own token under ~/.afw/oauth/
// and never reads Claude Code's Keychain or Codex's auth.json. The orchestrator
// reads + co-refreshes these tokens at request time. Onboarding (`afw model
// add`) drives the same flow; this command lets the user (re)log in directly.

import process from 'node:process'
import { Command } from 'commander'
import { logger } from '../../core/logger.ts'
import { type OAuthProviderKey, OAUTH_PROVIDERS, oauthLogin } from '../oauth/login.ts'

const PROVIDER_KEYS = Object.keys(OAUTH_PROVIDERS) as OAuthProviderKey[]

const loginCmd = new Command('login')
  .argument('[provider]', `provider to log in to (${PROVIDER_KEYS.join(', ')})`)
  .description('Log in to a model provider via OAuth and store the token in afw.')
  .action(async (provider?: string) => {
    try {
      if (!process.stdin.isTTY) {
        logger.print('oauth login needs an interactive terminal.')
        process.exitCode = 1
        return
      }
      const key = provider as OAuthProviderKey | undefined
      if (!key || !PROVIDER_KEYS.includes(key)) {
        logger.print(`usage: afw oauth login <${PROVIDER_KEYS.join('|')}>`)
        process.exitCode = 1
        return
      }
      const def = await oauthLogin(key)
      if (!def) {
        process.exitCode = 1
        return
      }
      logger.print(
        `\nDone. Register a route to it with \`afw model add\` (pick ${def.label}), ` +
          'or in the dashboard.',
      )
    } catch (e) {
      logger.print(`error: ${(e as Error).message}`)
      process.exit(1)
    }
  })

export const oauthCommand = new Command('oauth')
  .description('Manage afw-owned OAuth subscription logins (Anthropic, OpenAI).')
  .addCommand(loginCmd)
