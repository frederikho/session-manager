import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const isWindows = process.platform === 'win32'

function exists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * WSL distros visible from Windows. `wsl -l -q` emits UTF-16LE.
 * docker-desktop* are infrastructure distros with no user sessions.
 */
function wslDistros() {
  if (!isWindows) return []
  try {
    const raw = execFileSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer', timeout: 10_000 })
    return raw
      .toString('utf16le')
      .split(/\r?\n/)
      .map((l) => l.replace(/\0/g, '').trim())
      .filter(Boolean)
      .filter((d) => !/^docker-desktop/i.test(d))
  } catch {
    return []
  }
}

/** Home directories inside a WSL distro that actually hold agent state. */
function wslHomes(distro) {
  const base = `\\\\wsl.localhost\\${distro}`
  const candidates = []
  const homeRoot = path.join(base, 'home')
  try {
    for (const entry of fs.readdirSync(homeRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push({ user: entry.name, home: path.join(homeRoot, entry.name) })
    }
  } catch {
    /* distro not running or no /home */
  }
  const root = path.join(base, 'root')
  if (exists(root)) candidates.push({ user: 'root', home: root })
  return candidates.filter(({ home }) => exists(path.join(home, '.claude', 'projects')) || exists(path.join(home, '.codex', 'sessions')))
}


/**
 * Read-only mirrors of other machines, rsynced in by `bin/pull-remote.sh`.
 * Convention over configuration: every `remote/<host>/claude` or
 * `remote/<host>/codex` directory becomes a location labelled `<host>`.
 * Set SESSION_MIRROR_ROOT to keep them somewhere other than the project folder.
 */
function mirrorLocations() {
  const projectDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const root = process.env.SESSION_MIRROR_ROOT || path.join(projectDir, 'remote')
  const locations = []

  let hosts = []
  try {
    // statSync, not the dirent type: a mirror is often a symlink to a shared
    // partition, and dirent.isDirectory() is false for those.
    hosts = fs.readdirSync(root).filter((name) => {
      try {
        return fs.statSync(path.join(root, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return locations
  }

  for (const host of hosts) {
    for (const agent of ['claude', 'codex']) {
      const dir = path.join(root, host, agent)
      if (!exists(dir)) continue
      locations.push({
        id: `mirror-${host}-${agent}`,
        label: `${host} · ${agent === 'claude' ? 'Claude' : 'Codex'}`,
        host,
        agent,
        root: dir,
        readOnly: true,
      })
    }
  }
  return locations
}

/**
 * Every local place sessions live, as {id, label, host, agent, root}.
 * `root` is the projects/ or sessions/ directory itself.
 */
export function discoverLocations() {
  const locations = []

  const localHome = os.homedir()
  const localHost = isWindows ? 'Windows' : os.hostname()
  const localPrefix = isWindows ? 'win' : 'local'

  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(localHome, '.claude')
  const codexHome = process.env.CODEX_HOME || path.join(localHome, '.codex')

  if (exists(path.join(claudeHome, 'projects'))) {
    locations.push({
      id: `${localPrefix}-claude`,
      label: `${localHost} · Claude`,
      host: localHost,
      agent: 'claude',
      root: path.join(claudeHome, 'projects'),
    })
  }
  if (exists(path.join(codexHome, 'sessions'))) {
    locations.push({
      id: `${localPrefix}-codex`,
      label: `${localHost} · Codex`,
      host: localHost,
      agent: 'codex',
      root: path.join(codexHome, 'sessions'),
    })
  }

  for (const distro of wslDistros()) {
    const homes = wslHomes(distro)
    for (const { user, home } of homes) {
      const label = homes.length > 1 ? `${distro}/${user}` : distro
      if (exists(path.join(home, '.claude', 'projects'))) {
        locations.push({
          id: `wsl-${distro}-${user}-claude`,
          label: `WSL ${label} · Claude`,
          host: `WSL ${distro}`,
          agent: 'claude',
          root: path.join(home, '.claude', 'projects'),
        })
      }
      if (exists(path.join(home, '.codex', 'sessions'))) {
        locations.push({
          id: `wsl-${distro}-${user}-codex`,
          label: `WSL ${label} · Codex`,
          host: `WSL ${distro}`,
          agent: 'codex',
          root: path.join(home, '.codex', 'sessions'),
        })
      }
    }
  }

  locations.push(...mirrorLocations())

  return locations
}

/**
 * The OneDrive folders the machines share.
 * Claude bundles live in `<onedrive>/claude-sessions/<name>/session-bundle/...`,
 * Codex conversations in `<onedrive>/codex/sessions/<name>/session.jsonl`.
 */
export function discoverShared() {
  const explicitClaude = process.env.CLAUDE_SESSION_SYNC_ROOT
  const explicitCodex = process.env.CODEX_SESSION_SYNC_ROOT

  const bases = []
  const home = os.homedir()
  try {
    // OneDrive folders can surface as reparse points, so test the path rather than the dirent type.
    for (const entry of fs.readdirSync(home)) {
      if (entry.startsWith('OneDrive') && exists(path.join(home, entry))) bases.push(path.join(home, entry))
    }
  } catch {
    /* ignore */
  }
  if (!isWindows) {
    for (const glob of ['/mnt/c/Users']) {
      try {
        for (const user of fs.readdirSync(glob)) {
          for (const entry of fs.readdirSync(path.join(glob, user))) {
            if (entry.startsWith('OneDrive')) bases.push(path.join(glob, user, entry))
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  const claudeRoot = explicitClaude || bases.map((b) => path.join(b, 'claude-sessions')).find(exists) || null
  const codexRoot = explicitCodex || bases.map((b) => path.join(b, 'codex', 'sessions')).find(exists) || null

  return { claude: claudeRoot, codex: codexRoot }
}

/**
 * Claude derives a project directory name from the cwd by replacing every
 * non-alphanumeric character with a dash: C:\Users\me\proj -> C--Users-me-proj
 */
export function encodeProjectDir(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-')
}
