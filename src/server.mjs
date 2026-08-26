import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { deleteShared, pull, push, rename } from './actions.mjs'
import { scanAll } from './scan.mjs'
import { readTranscript, searchTranscript } from './transcript.mjs'

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/** Run one action per session and report per-session outcomes. */
function runBatch(sessions, fn) {
  const results = []
  for (const session of sessions) {
    try {
      results.push({ key: session.key, ok: true, ...fn(session) })
    } catch (err) {
      results.push({ key: session.key, ok: false, error: err.message })
    }
  }
  return results
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      // Inside the try: a malformed request path (e.g. "//") makes URL throw, and
      // an uncaught throw here would take the whole server down.
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/api/scan') {
        return send(res, 200, scanAll())
      }

      if (req.method === 'POST' && url.pathname === '/api/transcript') {
        const { session } = await readBody(req)
        if (!session?.file) return send(res, 400, { error: 'No session given.' })
        return send(res, 200, await readTranscript(session.file, session.agent))
      }

      if (req.method === 'POST' && url.pathname === '/api/search') {
        const { q } = await readBody(req)
        const needle = String(q || '').trim().toLowerCase()
        if (needle.length < 2) return send(res, 400, { error: 'Type at least two characters.' })

        const started = Date.now()
        const targets = scanAll().sessions.filter((s) => s.file)
        const results = {}

        // Bounded concurrency: transcripts are I/O bound, but unbounded fan-out
        // over a hundred files just thrashes.
        let next = 0
        const workers = Array.from({ length: 8 }, async () => {
          while (next < targets.length) {
            const session = targets[next++]
            try {
              const found = await searchTranscript(session.file, session.agent, needle)
              if (found.hits) results[session.key] = found
            } catch {
              /* unreadable transcript is simply not a match */
            }
          }
        })
        await Promise.all(workers)

        return send(res, 200, { query: needle, results, scanned: targets.length, took: Date.now() - started })
      }

      if (req.method === 'POST' && url.pathname === '/api/rename') {
        const { session, name } = await readBody(req)
        return send(res, 200, rename(session, name))
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        const body = await readBody(req)
        const sessions = body.sessions || []
        if (!sessions.length) return send(res, 400, { error: 'No sessions given.' })

        switch (url.pathname) {
          case '/api/push':
            return send(res, 200, { results: runBatch(sessions, (s) => push(s)) })
          case '/api/pull':
            return send(res, 200, {
              results: runBatch(sessions, (s) => pull(s, body.targetLocationId, { overwrite: body.overwrite })),
            })
          case '/api/delete-shared':
            return send(res, 200, { results: runBatch(sessions, (s) => deleteShared(s)) })
          default:
            return send(res, 404, { error: 'Unknown endpoint.' })
        }
      }

      const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
      const target = path.join(publicDir, file)
      if (!target.startsWith(publicDir) || !fs.existsSync(target)) return send(res, 404, 'Not found', 'text/plain')
      return send(res, 200, fs.readFileSync(target), MIME[path.extname(target)] || 'application/octet-stream')
    } catch (err) {
      return send(res, 500, { error: err.message })
    }
  })
}
