import fs from 'node:fs'

const HEAD_BYTES = 256 * 1024
const TAIL_BYTES = 64 * 1024

/** Read the first and last chunk of a jsonl file without loading the whole thing. */
function readEdges(file, size) {
  const fd = fs.openSync(file, 'r')
  try {
    const headLen = Math.min(HEAD_BYTES, size)
    const head = Buffer.alloc(headLen)
    fs.readSync(fd, head, 0, headLen, 0)

    let tail = Buffer.alloc(0)
    if (size > headLen) {
      const tailLen = Math.min(TAIL_BYTES, size - headLen)
      tail = Buffer.alloc(tailLen)
      fs.readSync(fd, tail, 0, tailLen, size - tailLen)
    }
    return { head: head.toString('utf8'), tail: tail.toString('utf8') }
  } finally {
    fs.closeSync(fd)
  }
}

function parseLines(text, { dropFirst = false, dropLast = false } = {}) {
  const lines = text.split('\n')
  if (dropLast) lines.pop()
  if (dropFirst) lines.shift()
  const out = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      /* truncated edge line */
    }
  }
  return out
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** Boilerplate that gets injected as a "user" turn but is not something the user typed. */
const NOISE = [
  /^<command-name>/,
  /^<local-command-stdout>/,
  /^<system-reminder>/,
  /^<user_instructions/,
  /^<environment_context/,
  /^<permissions instructions>/,
  /^Caveat: The messages below/,
  /^# AGENTS\.md instructions/,
  /^# CLAUDE\.md/,
  /^The following is the Codex agent history/,
  /^<turn_aborted>/,
  /^<user_action>/,
  /^\[Request interrupted/,
  /^This session is being continued from a previous/,
]

function isNoise(text) {
  const t = text.trim()
  if (!t) return true
  return NOISE.some((re) => re.test(t))
}

function summarise(text) {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

/** Metadata for a Claude Code transcript (`~/.claude/projects/<project>/<uuid>.jsonl`). */
export function parseClaudeSession(file, stat) {
  const { head, tail } = readEdges(file, stat.size)
  const headRecords = parseLines(head, { dropLast: stat.size > HEAD_BYTES })
  const tailRecords = parseLines(tail, { dropFirst: true })

  let id = null
  let cwd = null
  let gitBranch = null
  let version = null
  let title = null
  let startedAt = null

  for (const rec of headRecords) {
    id ||= rec.sessionId || null
    cwd ||= rec.cwd || null
    gitBranch ||= rec.gitBranch || null
    version ||= rec.version || null
    startedAt ||= rec.timestamp || null
    if (!title && rec.type === 'user' && !rec.isMeta && !rec.isSidechain) {
      const text = textOf(rec.message?.content ?? rec.content)
      if (!isNoise(text)) title = summarise(text)
    }
  }

  let updatedAt = null
  for (const rec of [...tailRecords, ...headRecords].reverse()) {
    if (rec.timestamp) {
      updatedAt = rec.timestamp
      break
    }
  }

  return {
    agent: 'claude',
    id,
    title: title || '(no prompt yet)',
    cwd,
    gitBranch,
    version,
    startedAt,
    updatedAt: updatedAt || stat.mtime.toISOString(),
  }
}

/** Metadata for a Codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`). */
export function parseCodexSession(file, stat) {
  const { head, tail } = readEdges(file, stat.size)
  const headRecords = parseLines(head, { dropLast: stat.size > HEAD_BYTES })
  const tailRecords = parseLines(tail, { dropFirst: true })

  let id = null
  let cwd = null
  let version = null
  let title = null
  let startedAt = null
  let parentThreadId = null

  for (const rec of headRecords) {
    if (rec.type === 'session_meta') {
      const p = rec.payload || {}
      id ||= p.id || p.session_id || null
      cwd ||= p.cwd || null
      version ||= p.cli_version || null
      startedAt ||= p.timestamp || rec.timestamp || null
      if (p.parent_thread_id && p.parent_thread_id !== (p.id || p.session_id)) parentThreadId = p.parent_thread_id
    }
    if (!title) {
      const p = rec.payload || {}
      if (rec.type === 'event_msg' && p.type === 'user_message') {
        const text = textOf(p.message)
        if (!isNoise(text)) title = summarise(text)
      } else if (rec.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        const text = textOf(p.content)
        if (!isNoise(text)) title = summarise(text)
      }
    }
  }

  let updatedAt = null
  for (const rec of [...tailRecords, ...headRecords].reverse()) {
    if (rec.timestamp) {
      updatedAt = rec.timestamp
      break
    }
  }

  return {
    agent: 'codex',
    id,
    title: title || '(no prompt yet)',
    cwd,
    gitBranch: null,
    version,
    startedAt,
    parentThreadId,
    updatedAt: updatedAt || stat.mtime.toISOString(),
  }
}

/** Filename-safe slug used for the shared folder name. */
export function slugify(text, fallback) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return slug || fallback
}
