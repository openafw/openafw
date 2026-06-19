import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { readConfig } from '../core/config.ts'
import { logger } from '../core/logger.ts'
import { VERSION } from '../core/version.ts'
import { api } from './api/index.ts'
import { initMaskingTable } from './masking/load.ts'
import { handleMcpRelay } from './mcp/relay.ts'
import { handleWireRequest } from './proxy/index.ts'
import { handleKeyRequest } from './proxy/keys.ts'
import { initRoutesTable, onRoutesReload } from './routes/load.ts'
import { initRoutingTables } from './routing/load.ts'
import { primeObservedModels, seedFromRoutes } from './routing/seed.ts'
import { getDb } from './store/db.ts'
import { consumePendingRestore } from './update/backup.ts'
import { initWireWatcher } from './wire/watcher.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
// In dev: src/daemon/ → ../../ui-dist
// In prod: dist/bin/  → ../../ui-dist
const UI_DIST = join(HERE, '..', '..', 'ui-dist')

const STARTED_AT = Date.now()

export async function startServer(opts: { port: number }): Promise<void> {
  await readConfig()
  await initRoutesTable()
  await initRoutingTables() // load model registry + routing policy + secrets
  await initMaskingTable() // load credential-masking rules (which are disabled)
  await primeObservedModels()
  void seedFromRoutes() // one seeded provider + harvested models per wire route
  onRoutesReload(() => void seedFromRoutes()) // keep them in sync
  await consumePendingRestore() // restore DB if a rollback queued one (before the DB is opened)
  await getDb() // open SQLite + run schema bootstrap
  await initWireWatcher() // watch wired files for drift

  const app = new Hono()

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      uptime: (Date.now() - STARTED_AT) / 1000,
      version: VERSION,
    }),
  )

  // REST API for the UI / CLI to query captured traces.
  app.route('/api', api)

  // Real reverse proxy with decoder dispatch.
  // Single path segment: the agent type. Body.model carries per-instance
  // dispatch (wrap-style: `afw-openclaw-main`; OAuth: real model id
  // like `claude-opus-4-7`). Proxy looks up `findRoute(agent, modelId)`.
  //
  // CORS: agents that fetch through afw from a browser/Electron
  // renderer (Claude Desktop's model-discovery panel is the headline
  // case) trigger preflight on non-simple headers like `anthropic-version`
  // and `x-api-key`. Without a CORS response the renderer aborts with
  // net::ERR_FAILED before the GET is sent. Open the wire path to any
  // origin — localhost:9877 is already a user-controlled trust boundary
  // (anything that can reach it can already issue normal proxy calls).
  // Echo the origin so the response works for renderers that send
  // `credentials: include` (Allow-Origin: * is rejected in that mode).
  app.use(
    '/wire/*',
    cors({
      // `origin: '*'` + `credentials: true` → hono echoes the request's
      // Origin in Access-Control-Allow-Origin (since `*` literal is
      // invalid with credentials). Echo is what we want — credentials
      // are needed when the renderer sends `fetch(..., {credentials:'include'})`.
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      // Leave allowHeaders/exposeHeaders empty: hono echoes the
      // preflight's Access-Control-Request-Headers verbatim. A literal
      // `*` would also fail under credentials.
      maxAge: 86400,
      credentials: true,
    }),
  )
  app.all('/wire/:agent/*', handleWireRequest)

  // MCP relay for http/sse MCP servers — forwards to the real upstream and
  // captures JSON-RPC frames. Distinct prefix from /wire/:agent/* (model
  // calls). Same open-CORS rationale (Claude Desktop is an Electron renderer).
  app.use(
    '/wire-mcp/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      maxAge: 86400,
      credentials: true,
    }),
  )
  app.all('/wire-mcp/:agent/:server/*', handleMcpRelay)
  app.all('/wire-mcp/:agent/:server', handleMcpRelay)

  // The afw API-key endpoint: a generic OpenAI/Anthropic-compatible agent
  // points its base URL at `…/v1` and authenticates with an afw-issued
  // token. The token (not a URL path segment) selects the model. Same open-CORS
  // rationale as /wire/* — localhost:9877 is already the trust boundary.
  app.use(
    '/v1/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      maxAge: 86400,
      credentials: true,
    }),
  )
  app.all('/v1/*', handleKeyRequest)

  // Static UI bundle (built from internal/ui via `npm run ui:build`).
  // Registered last so it acts as the fallthrough. Mounted unconditionally and
  // resolved per-request from disk: serveStatic serves whatever ui-dist holds
  // right now (so a `npm run build` after the daemon started shows up on the
  // next refresh — no restart needed), and calls next() when the bundle is
  // missing, where the stub answers '/'.
  app.use('/*', serveStatic({ root: UI_DIST }))
  app.get('/', (c) => c.html(STUB_HTML))
  if (!existsSync(UI_DIST)) {
    logger.warn(`ui-dist not built yet at ${UI_DIST}; serving stub until \`npm run ui:build\`.`)
  }

  await new Promise<void>((resolve) => {
    serve({ fetch: app.fetch, port: opts.port }, () => {
      resolve()
    })
  })
}

const STUB_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>afw</title>
  <style>
    body { font: 14px/1.6 -apple-system, BlinkMacSystemFont, sans-serif;
           max-width: 640px; margin: 4em auto; padding: 0 1em; color: #222 }
    h1 { font-size: 1.4em; margin-bottom: 0 }
    .slug { color: #888; margin-top: 0.2em }
    code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px }
  </style>
</head>
<body>
  <h1>afw</h1>
  <p class="slug">An AI agent firewall on the wire.</p>
  <p>The daemon is running. Use the CLI: <code>afw status</code>, <code>afw key</code>.</p>
  <p>Connecting an app/daemon agent (Hermes, OpenClaw)? Mint an API key with
     <code>afw key add</code>, then point the agent at <code>/v1</code>.</p>
</body>
</html>`
