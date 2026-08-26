import fs from 'node:fs'
import path from 'node:path'

import { slugify } from './parse.mjs'
import { discoverLocations, discoverShared, encodeProjectDir } from './paths.mjs'

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Guard every destructive path against the roots we actually manage. */
function assertManaged(target, roots) {
  const ok = roots.filter(Boolean).some((root) => isInside(root, target))
  if (!ok) throw new Error(`Refusing to touch a path outside the known session roots: ${target}`)
}

function uniqueName(root, base) {
  let name = base
  let n = 2
  while (fs.existsSync(path.join(root, name))) {
    name = `${base}-${n}`
    n += 1
  }
  return name
}

function locationById(id) {
  const loc = discoverLocations().find((l) => l.id === id)
  if (!loc) throw new Error(`Unknown location: ${id}`)
  return loc
}

function sharedRootFor(agent) {
  const shared = discoverShared()
  const root = agent === 'claude' ? shared.claude : shared.codex
  if (!root) throw new Error(`No shared OneDrive folder found for ${agent}. Set CLAUDE_SESSION_SYNC_ROOT / CODEX_SESSION_SYNC_ROOT.`)
  ensureDir(root)
  return root
}

/** Copy a local transcript up to the shared OneDrive folder. */
export function push(session) {
  const root = sharedRootFor(session.agent)
  const existingName = session.shared?.name
  const name = existingName || uniqueName(root, slugify(session.title, session.id))
  const dir = path.join(root, name)

  const manifest = {
    name,
    saved_at: new Date().toISOString(),
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    project_dir: session.project || null,
    started_at: session.startedAt || null,
    updated_at: session.updatedAt || null,
    source_file: session.file,
    saved_from: session.locationLabel,
    original_relative_path: session.relativePath,
    bytes: session.size,
  }

  if (session.agent === 'claude') {
    const target = path.join(dir, 'session-bundle', 'claude-session')
    ensureDir(target)
    fs.copyFileSync(session.file, path.join(target, `${session.id}.jsonl`))
    // Sidecar directory holds subagent transcripts for the same session.
    const sidecar = path.join(path.dirname(session.file), session.id)
    if (fs.existsSync(sidecar)) {
      fs.cpSync(sidecar, path.join(target, session.id), { recursive: true })
    }
  } else {
    ensureDir(dir)
    fs.copyFileSync(session.file, path.join(dir, 'session.jsonl'))
  }

  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { name, dir }
}

/** Restore a shared conversation into one of the local roots. */
export function pull(session, targetLocationId, { overwrite = false } = {}) {
  const loc = locationById(targetLocationId)
  if (loc.agent !== session.agent) throw new Error(`${session.agent} session cannot be restored into a ${loc.agent} location.`)

  const sourceFile = session.shared?.file || session.file
  let destination

  if (loc.agent === 'claude') {
    const project = session.project || encodeProjectDir(session.cwd)
    if (!project) throw new Error('Cannot determine the project folder for this session.')
    destination = path.join(loc.root, project, `${session.id}.jsonl`)
  } else {
    let rel = session.relativePath
    if (!rel) {
      const when = new Date(session.updatedAt || Date.now())
      const y = when.getUTCFullYear()
      const m = String(when.getUTCMonth() + 1).padStart(2, '0')
      const d = String(when.getUTCDate()).padStart(2, '0')
      const stamp = when.toISOString().replace(/[:.]/g, '-').slice(0, 19)
      rel = `${y}/${m}/${d}/rollout-${stamp}-${session.id}.jsonl`
    }
    destination = path.join(loc.root, ...rel.split('/'))
  }

  if (fs.existsSync(destination) && !overwrite) {
    return { skipped: true, destination, reason: 'A file already exists at that path. Re-run with overwrite to replace it.' }
  }

  ensureDir(path.dirname(destination))
  fs.copyFileSync(sourceFile, destination)

  // Bring subagent transcripts along when the bundle carries them.
  const sidecar = path.join(path.dirname(sourceFile), session.id)
  if (loc.agent === 'claude' && fs.existsSync(sidecar)) {
    fs.cpSync(sidecar, path.join(path.dirname(destination), session.id), { recursive: true, force: overwrite })
  }

  return { skipped: false, destination }
}

/**
 * Rename the shared copy. Local transcripts are named by session id, so the
 * friendly name only exists in the shared folder.
 */
export function rename(session, requestedName) {
  const dir = session.shared?.dir
  if (!dir) throw new Error('Only sessions saved to OneDrive can be renamed.')

  const clean = String(requestedName || '')
    .trim()
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 100)
  if (!clean) throw new Error('That name is empty after removing characters folders cannot contain.')

  const shared = discoverShared()
  assertManaged(dir, [shared.claude, shared.codex])

  const parent = path.dirname(dir)
  const target = path.join(parent, clean)
  if (path.resolve(target) === path.resolve(dir)) return { name: clean, dir }
  if (fs.existsSync(target)) throw new Error(`A saved conversation named "${clean}" already exists.`)

  fs.renameSync(dir, target)

  const manifestPath = path.join(target, 'manifest.json')
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.name = clean
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  } catch {
    /* legacy bundles may have no manifest; the folder name is the source of truth */
  }

  return { name: clean, dir: target }
}

/** Delete the OneDrive copy — this removes it from every machine. */
export function deleteShared(session) {
  const dir = session.shared?.dir
  if (!dir) throw new Error('This session has no copy in the shared folder.')
  const shared = discoverShared()
  assertManaged(dir, [shared.claude, shared.codex])

  fs.rmSync(dir, { recursive: true, force: true })
  return { deleted: dir }
}
