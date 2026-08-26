#!/usr/bin/env node
import { execFile } from 'node:child_process'

import { createServer } from '../src/server.mjs'
import { scanAll } from '../src/scan.mjs'

const args = process.argv.slice(2)

function flag(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

function openBrowser(url) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url])
  else if (process.platform === 'darwin') execFile('open', [url])
  else execFile('xdg-open', [url], () => {})
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`sessions — browse, sync and delete Claude Code + Codex sessions

  sessions                 start the GUI and open it in the browser
  sessions --port 62841    use a specific port
  sessions --no-open       start the server without opening a browser
  sessions --list          print a summary to the terminal instead of the GUI
  sessions --json          print the full scan as JSON
`)
  process.exit(0)
}

if (args.includes('--list') || args.includes('--json')) {
  const data = scanAll()
  if (args.includes('--json')) {
    console.log(JSON.stringify(data, null, 2))
  } else {
    console.log(`Locations:`)
    for (const loc of data.locations) console.log(`  ${loc.label}  ${loc.root}`)
    console.log(`\nShared: claude=${data.shared.claude || '(none)'}\n        codex=${data.shared.codex || '(none)'}`)
    const counts = {}
    for (const s of data.sessions) counts[s.status] = (counts[s.status] || 0) + 1
    console.log(`\n${data.sessions.length} sessions: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`)
    if (data.emptySkipped) console.log(`${data.emptySkipped} empty session${data.emptySkipped === 1 ? '' : 's'} hidden (opened, never used)`)
  }
  process.exit(0)
}

// Above the kernel's ephemeral range (32768-60999), so an outgoing
// connection can never have taken it first, and clear of the ports dev
// tools reach for by habit.
const DEFAULT_PORT = 62841

const port = Number(flag('port', DEFAULT_PORT))
const server = createServer()

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`
  console.log(`Session manager running at ${url}`)
  console.log('Press Ctrl+C to stop.')
  if (!args.includes('--no-open')) openBrowser(url)
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Try: sessions --port ${port + 1}`)
  else console.error(err.message)
  process.exit(1)
})
