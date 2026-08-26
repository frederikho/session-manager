import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseClaudeSession, parseCodexSession } from './parse.mjs'
import { discoverLocations, discoverShared } from './paths.mjs'

const CACHE_FILE = path.join(os.homedir(), '.session-manager-cache.json')

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache))
  } catch {
    /* cache is best-effort */
  }
}

function statOrNull(p) {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** Every `<project>/<uuid>.jsonl` under a Claude projects root. */
function listClaudeFiles(root) {
  const files = []
  let projects = []
  try {
    projects = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return files
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = path.join(root, project.name)
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push({ file: path.join(dir, entry.name), project: project.name })
      }
    }
  }
  return files
}

/** Every `YYYY/MM/DD/rollout-*.jsonl` under a Codex sessions root. */
function listCodexFiles(root) {
  const files = []
  const walk = (dir, depth) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory() && depth < 3) walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push({ file: full })
    }
  }
  walk(root, 0)
  return files
}

function parseWithCache(file, stat, agent, cache, nextCache) {
  const key = `${file}|${stat.size}|${stat.mtimeMs}`
  if (cache[key]) {
    nextCache[key] = cache[key]
    return cache[key]
  }
  const meta = agent === 'claude' ? parseClaudeSession(file, stat) : parseCodexSession(file, stat)
  nextCache[key] = meta
  return meta
}

/** Sessions found on this machine and in the WSL distros. */
function scanLocal(locations, cache, nextCache) {
  const sessions = []
  for (const loc of locations) {
    const files = loc.agent === 'claude' ? listClaudeFiles(loc.root) : listCodexFiles(loc.root)
    for (const { file, project } of files) {
      const stat = statOrNull(file)
      if (!stat || stat.size === 0) continue
      let meta
      try {
        meta = parseWithCache(file, stat, loc.agent, cache, nextCache)
      } catch {
        continue
      }
      const id = meta.id || path.basename(file, '.jsonl')
      sessions.push({
        key: `${loc.id}:${id}`,
        id,
        agent: loc.agent,
        locationId: loc.id,
        locationLabel: loc.label,
        host: loc.host,
        file,
        project: project || null,
        relativePath: path.relative(loc.root, file).split(path.sep).join('/'),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        title: meta.title,
        cwd: meta.cwd,
        gitBranch: meta.gitBranch || null,
        startedAt: meta.startedAt,
        updatedAt: meta.updatedAt,
        isSubagentThread: Boolean(meta.parentThreadId),
      })
    }
  }
  return sessions
}

/**
 * Manifests written by the older sync skill often captured injected boilerplate
 * as the title, so prefer what the transcript itself says.
 */
function describeShared(file, stat, agent, manifest) {
  let parsed = {}
  try {
    parsed = agent === 'claude' ? parseClaudeSession(file, stat) : parseCodexSession(file, stat)
  } catch {
    parsed = {}
  }
  const title = parsed.title && parsed.title !== '(no prompt yet)' ? parsed.title : manifest.title || null
  return {
    id: parsed.id || manifest.id || null,
    title,
    cwd: parsed.cwd || manifest.cwd || null,
  }
}

/** Conversations already saved to the shared OneDrive folder. */
function scanShared(shared) {
  const entries = []

  if (shared.claude) {
    let dirs = []
    try {
      dirs = fs.readdirSync(shared.claude, { withFileTypes: true })
    } catch {
      dirs = []
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const base = path.join(shared.claude, dir.name)
      const sessionDir = path.join(base, 'session-bundle', 'claude-session')
      let files = []
      try {
        files = fs.readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'))
      } catch {
        continue
      }
      const manifest = readJson(path.join(base, 'manifest.json')) || {}
      for (const f of files) {
        const file = path.join(sessionDir, f)
        const stat = statOrNull(file)
        if (!stat) continue
        const described = describeShared(file, stat, 'claude', manifest)
        entries.push({
          key: `shared-claude:${dir.name}:${path.basename(f, '.jsonl')}`,
          agent: 'claude',
          id: described.id || path.basename(f, '.jsonl'),
          name: dir.name,
          dir: base,
          file,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          savedAt: manifest.saved_at || stat.mtime.toISOString(),
          title: described.title || dir.name,
          cwd: described.cwd,
          project: manifest.project_dir || null,
          originalRelativePath: manifest.original_relative_path || null,
          savedFrom: manifest.saved_from || null,
          extras: fs
            .readdirSync(path.join(base, 'session-bundle'), { withFileTypes: true })
            .filter((e) => e.isDirectory() && e.name !== 'claude-session')
            .map((e) => e.name),
        })
      }
    }
  }

  if (shared.codex) {
    let dirs = []
    try {
      dirs = fs.readdirSync(shared.codex, { withFileTypes: true })
    } catch {
      dirs = []
    }
    for (const dir of dirs) {
      if (!dir.isDirectory() || dir.name === 'snapshots') continue
      const base = path.join(shared.codex, dir.name)
      const file = path.join(base, 'session.jsonl')
      const stat = statOrNull(file)
      if (!stat) continue
      const manifest = readJson(path.join(base, 'manifest.json')) || {}
      const described = describeShared(file, stat, 'codex', manifest)
      entries.push({
        key: `shared-codex:${dir.name}`,
        agent: 'codex',
        id: described.id,
        name: dir.name,
        dir: base,
        file,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        savedAt: manifest.saved_at || stat.mtime.toISOString(),
        title: described.title || dir.name,
        cwd: described.cwd,
        project: null,
        originalRelativePath: manifest.original_relative_path || null,
        savedFrom: manifest.source_file || null,
        extras: [],
      })
    }
  }

  return entries
}

/**
 * Sync state is decided by byte size, which is monotonic for append-only
 * transcripts: same size means the copies match, a bigger local file means
 * the conversation continued after it was saved.
 */
function compare(local, remote) {
  if (!remote) return 'local-only'
  if (local.size === remote.size) return 'synced'
  if (local.size > remote.size) return 'local-newer'
  return 'remote-newer'
}

export function scanAll() {
  const locations = discoverLocations()
  const shared = discoverShared()

  const cache = loadCache()
  const nextCache = {}
  const localSessions = scanLocal(locations, cache, nextCache)
  saveCache(nextCache)

  const sharedEntries = scanShared(shared)
  const sharedById = new Map()
  for (const entry of sharedEntries) {
    if (entry.id) sharedById.set(`${entry.agent}:${entry.id}`, entry)
  }

  const matchedShared = new Set()
  const sessions = localSessions.map((session) => {
    const remote = sharedById.get(`${session.agent}:${session.id}`) || null
    if (remote) matchedShared.add(remote.key)
    return {
      ...session,
      status: compare(session, remote),
      shared: remote
        ? { key: remote.key, name: remote.name, dir: remote.dir, file: remote.file, size: remote.size, savedAt: remote.savedAt }
        : null,
    }
  })

  // Shared conversations with no copy on this machine can still be pulled down.
  for (const entry of sharedEntries) {
    if (matchedShared.has(entry.key)) continue
    sessions.push({
      key: entry.key,
      id: entry.id || entry.name,
      agent: entry.agent,
      locationId: 'shared',
      locationLabel: 'OneDrive only',
      host: 'OneDrive',
      file: entry.file,
      project: entry.project,
      relativePath: entry.originalRelativePath,
      size: entry.size,
      mtime: entry.mtime,
      title: entry.title,
      cwd: entry.cwd,
      gitBranch: null,
      startedAt: null,
      updatedAt: entry.savedAt,
      isSubagentThread: false,
      status: 'remote-only',
      shared: { key: entry.key, name: entry.name, dir: entry.dir, file: entry.file, size: entry.size, savedAt: entry.savedAt },
    })
  }

  sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))

  return {
    scannedAt: new Date().toISOString(),
    locations,
    shared,
    sessions,
    sharedEntries,
  }
}
