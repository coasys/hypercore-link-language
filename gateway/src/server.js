/**
 * Hypercore Autobase Gateway — HTTP server.
 *
 * A Node.js sidecar the Deno-sandboxed AD4M link language reaches over HTTP.
 * The sandbox cannot run native Hypercore/Autobase/Hyperswarm (RocksDB storage,
 * UDP DHT, in-process linearization), so that work lives here. The gateway owns
 * one Autobase per neighbourhood and exposes the REST contract in routes.js.
 *
 * Configuration (environment):
 *   PORT            HTTP listen port          (default 7790)
 *   STORAGE_ROOT    per-base Corestore root   (default ./.gateway-storage)
 */

import http from 'http'
import path from 'path'
import { GatewayState } from './state.js'
import * as routes from './routes.js'

// ---------------------------------------------------------------------------
// Tiny router: method + path-pattern → handler(req, res, params, body, query)
// ---------------------------------------------------------------------------

function buildRoutes (state) {
  return [
    { method: 'GET', pattern: '/health', handler: routes.health(state) },
    { method: 'POST', pattern: '/bases', handler: routes.createBase(state) },
    { method: 'GET', pattern: '/bases/:key/revision', handler: routes.getRevision(state) },
    { method: 'GET', pattern: '/bases/:key/links', handler: routes.getLinks(state) },
    { method: 'GET', pattern: '/bases/:key/oplog', handler: routes.getOplog(state) },
    { method: 'GET', pattern: '/bases/:key/diff', handler: routes.getDiff(state) },
    { method: 'POST', pattern: '/bases/:key/commit', handler: routes.commit(state) },
    { method: 'POST', pattern: '/bases/:key/writers', handler: routes.addWriter(state) },
    { method: 'POST', pattern: '/bases/:key/replicate', handler: routes.startReplicate(state) },
    { method: 'DELETE', pattern: '/bases/:key/replicate', handler: routes.stopReplicate(state) },
    { method: 'GET', pattern: '/bases/:key', handler: routes.getBase(state) }
  ]
}

function matchRoute (routeList, method, pathname) {
  const segments = pathname.split('/').filter(Boolean)
  for (const route of routeList) {
    if (route.method !== method) continue
    const patSegs = route.pattern.split('/').filter(Boolean)
    if (patSegs.length !== segments.length) continue
    const params = {}
    let ok = true
    for (let i = 0; i < patSegs.length; i++) {
      if (patSegs[i].startsWith(':')) {
        params[patSegs[i].slice(1)] = decodeURIComponent(segments[i])
      } else if (patSegs[i] !== segments[i]) {
        ok = false
        break
      }
    }
    if (ok) return { handler: route.handler, params }
  }
  return null
}

function readBody (req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined)
      const raw = Buffer.concat(chunks).toString('utf-8')
      if (!raw) return resolve(undefined)
      try { resolve(JSON.parse(raw)) } catch { resolve(undefined) }
    })
    req.on('error', () => resolve(undefined))
  })
}

/**
 * Create the HTTP server (without listening) — used by tests to drive the
 * gateway on an ephemeral port.
 * @param {GatewayState} state
 * @returns {http.Server}
 */
export function createServer (state) {
  const routeList = buildRoutes(state)
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const match = matchRoute(routeList, req.method, url.pathname)
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `no route for ${req.method} ${url.pathname}` }))
        return
      }
      const body = (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE')
        ? await readBody(req)
        : undefined
      await match.handler(req, res, match.params, body, url.searchParams)
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `internal: ${e && e.message}` }))
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

function isMain () {
  return import.meta.url === `file://${process.argv[1]}`
}

if (isMain()) {
  const port = parseInt(process.env.PORT || '7790', 10)
  const storageRoot = process.env.STORAGE_ROOT || path.join(process.cwd(), '.gateway-storage')
  const state = new GatewayState(storageRoot)
  const server = createServer(state)

  server.listen(port, () => {
    console.log(`[hypercore-gateway] listening on http://0.0.0.0:${port} (storage: ${storageRoot})`)
  })

  const shutdown = async () => {
    console.log('[hypercore-gateway] shutting down…')
    server.close()
    await state.closeAll()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
