const state = {
  data: null,
  selected: new Set(),
  filters: { search: '', agent: '', location: '', status: '' },
  contentSearch: { query: '', results: null, running: false },
  detailedView: loadPref('detailedView', false),
  hideSubagents: true,
  expanded: null,
  transcripts: new Map(),
  lastRefresh: null,
}

function loadPref(key, fallback) {
  try {
    const raw = localStorage.getItem(`session-manager.${key}`)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

function savePref(key, value) {
  try {
    localStorage.setItem(`session-manager.${key}`, JSON.stringify(value))
  } catch {
    /* private windows and blocked site data are fine; the preference just won't stick */
  }
}

const $ = (id) => document.getElementById(id)

const STATE_LABEL = {
  synced: 'Synced',
  'local-only': 'Not synced',
  'local-newer': 'Local ahead',
  'remote-newer': 'OneDrive ahead',
  'remote-only': 'OneDrive only',
}

function formatMessages(m) {
  if (!m || !m.total) return '<span class="dim">—</span>'
  return `<span title="${m.user} from you, ${m.assistant} in reply">${m.total}</span>`
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatWhen(iso) {
  if (!iso) return '—'
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return '—'
  const mins = Math.round((Date.now() - then.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  if (mins < 60 * 24 * 30) return `${Math.round(mins / 1440)}d ago`
  return then.toLocaleDateString()
}

function toast(message, isError = false) {
  const el = $('toast')
  el.textContent = message
  el.classList.toggle('error', isError)
  el.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => {
    el.hidden = true
  }, 6000)
}

async function api(pathname, body) {
  const res = await fetch(pathname, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || res.statusText)
  return json
}

function visibleSessions() {
  const { search, agent, location, status } = state.filters
  const needle = search.trim().toLowerCase()
  return state.data.sessions.filter((s) => {
    if (agent && s.agent !== agent) return false
    if (location && s.locationId !== location) return false
    if (status && s.status !== status) return false
    if (state.hideSubagents && s.isSubagentThread) return false
    if (!needle) return true
    const meta = [s.title, s.cwd, s.id, s.project, s.locationLabel].filter(Boolean).join(' ').toLowerCase()
    if (meta.includes(needle)) return true
    const content = state.contentSearch
    return content.query === needle && Boolean(content.results?.[s.key])
  })
}

function renderStats() {
  const sessions = state.data.sessions
  const count = (status) => sessions.filter((s) => s.status === status).length
  const unsynced = count('local-only') + count('local-newer')
  $('stats').innerHTML = `
    <div class="stat"><b>${sessions.length}</b><span>sessions</span></div>
    <div class="stat ok"><b>${count('synced')}</b><span>synced</span></div>
    <div class="stat warn"><b>${unsynced}</b><span>need upload</span></div>
    <div class="stat accent"><b>${count('remote-only')}</b><span>only on OneDrive</span></div>
    <div class="stat"><b>${state.data.locations.length}</b><span>locations</span></div>
    ${state.data.emptySkipped ? `<div class="stat"><b>${state.data.emptySkipped}</b><span>empty, hidden</span></div>` : ''}`
}

/**
 * Just enough markdown for a readable conversation: fenced code, inline code,
 * bold/italic, headings and bullets. Everything is escaped first, so the
 * replacements below can never introduce markup from the transcript itself.
 */
const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/** Column alignment from the `|:---|---:|:--:|` row. */
function alignments(line) {
  return splitRow(line).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return ' style="text-align:center"'
    if (right) return ' style="text-align:right"'
    return ''
  })
}

/** A pipe table, or null when the block is not one. */
function renderTable(lines) {
  const sep = lines.findIndex((l) => SEPARATOR.test(l))
  if (sep === -1 || sep > 1) return null
  if (!lines.some((l) => l.includes('|'))) return null

  const align = alignments(lines[sep])
  const header = sep === 1 ? splitRow(lines[0]) : null
  const body = lines.slice(sep + 1).filter((l) => l.trim())
  if (!header && !body.length) return null

  const cell = (tag, values) =>
    `<tr>${values.map((v, i) => `<${tag}${align[i] || ''}>${v}</${tag}>`).join('')}</tr>`

  const head = header ? `<thead>${cell('th', header)}</thead>` : ''
  const rows = body.map((l) => cell('td', splitRow(l))).join('')
  return `<div class="md-table-wrap"><table class="md-table">${head}<tbody>${rows}</tbody></table></div>`
}

function renderMarkdown(text) {
  const blocks = []
  let html = escapeHtml(text)

  // Pull fenced code out first so its contents are never touched by inline rules.
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre class="code"${lang ? ` data-lang="${lang}"` : ''}><code>${code.replace(/\n$/, '')}</code></pre>`)
    return `@@CODEBLOCK${blocks.length - 1}@@`
  })

  html = html
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')

  // Real block structure: spacing comes from margins alone. Mixing preserved
  // newlines (pre-wrap) with block margins is what doubled the gaps around
  // headings and lists.
  const out = html
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim()
      if (!trimmed) return ''
      if (/^@@CODEBLOCK\d+@@$/.test(trimmed)) return trimmed

      const lines = trimmed.split('\n')

      const table = renderTable(lines)
      if (table) return table

      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${l.replace(/^\s*[-*]\s+/, '')}</li>`).join('')}</ul>`
      }

      const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed)
      if (heading && lines.length === 1) return `<p class="md-h">${heading[2]}</p>`

      return `<p>${lines.map((l) => l.replace(/^(#{1,6})\s+/, '')).join('<br>')}</p>`
    })
    .filter(Boolean)
    .join('')

  return out.replace(/@@CODEBLOCK(\d+)@@/g, (_, i) => blocks[Number(i)])
}

/** The plain conversation: what each side actually said, nothing else. */
function renderPlainMessage(m, idx) {
  if (m.role !== 'user' && m.role !== 'assistant') return ''
  if (m.boilerplate) return ''
  const text = (m.parts || [])
    .filter((p) => p.kind === 'text')
    .map((p) => p.text)
    .join('\n\n')
    .trim()
  if (!text) return ''

  return `<div class="turn ${m.role}" data-msg-idx="${idx}">
    <div class="turn-who">${m.role === 'user' ? 'You' : 'Assistant'}${m.at ? `<span class="turn-at">${new Date(m.at).toLocaleString()}</span>` : ''}</div>
    <div class="turn-body">${renderMarkdown(text)}</div>
  </div>`
}

/** Everything the transcript holds: reasoning, tool calls and tool output too. */
function renderMessage(m, idx) {
  if (m.role === 'meta') return `<div class="msg meta-msg">${escapeHtml(m.text)}</div>`
  if (m.role === 'tool-result') return `<div class="msg tool-result"><pre>${escapeHtml(m.text)}</pre></div>`

  const parts = (m.parts || [])
    .map((p) => {
      if (p.kind === 'text') return `<div class="part">${escapeHtml(p.text)}</div>`
      if (p.kind === 'thinking') return `<div class="part thinking">${escapeHtml(p.text)}</div>`
      return `<div class="part tool"><b>${escapeHtml(p.text)}</b> <span>${escapeHtml(p.detail || '')}</span></div>`
    })
    .join('')

  return `<div class="msg ${m.role}" data-msg-idx="${idx}">
    <div class="who">${m.role === 'user' ? 'You' : 'Assistant'}${m.at ? ` · ${new Date(m.at).toLocaleString()}` : ''}</div>
    ${parts}
  </div>`
}

function renderTranscript(session) {
  const entry = state.transcripts.get(session.key)
  if (!entry) return '<div class="transcript loading">Loading transcript…</div>'
  if (entry.error) return `<div class="transcript error-text">${escapeHtml(entry.error)}</div>`

  const detailed = state.detailedView
  const gap = entry.dropped
    ? `<div class="msg meta-msg">… ${entry.dropped} messages in the middle not shown (${entry.total} total) …</div>`
    : ''

  // The head/tail split happens at index 60 in the raw list; the plain view drops
  // messages, so place the gap marker by original index rather than by count.
  const body = []
  entry.messages.forEach((m, i) => {
    if (gap && i === 60) body.push(gap)
    const html = detailed ? renderMessage(m, m.idx ?? i) : renderPlainMessage(m, m.idx ?? i)
    if (html) body.push(html)
  })

  const shown = body.filter((h) => h !== gap).length
  const note = detailed
    ? `${entry.total} messages`
    : `${shown} turn${shown === 1 ? '' : 's'} shown · ${entry.total} records`

  return `<div class="transcript ${detailed ? 'detailed' : 'plain'}">
    <div class="transcript-head">
      <span>${note} · ${formatSize(entry.bytes)} · <code class="sid">${escapeHtml(session.id)}</code><button class="copy-id" data-copy="${escapeHtml(session.id)}" title="Copy session id">⧉</button></span>
      <span class="path">${escapeHtml(session.file)}</span>
    </div>
    ${body.join('') || '<div class="loading">Nothing readable in this transcript.</div>'}
  </div>`
}

function renderMachineBadge(s) {
  const color = state.data.machineColors?.[s.host]
  const style = color ? ` style="background:${color.bg};color:${color.fg}"` : ''
  return `<span class="machine-badge"${style}>${escapeHtml(s.locationLabel)}</span>`
}

function renderRows() {
  const sessions = visibleSessions()
  const rows = sessions
    .map((s) => {
      const checked = state.selected.has(s.key) ? 'checked' : ''
      const open = state.expanded === s.key
      const sharedNote = s.shared ? `OneDrive: ${s.shared.name}` : ''
      const found = state.contentSearch.results?.[s.key]
      const hits = found
        ? `<div class="hits"><span class="hit-count">${found.hits} match${found.hits === 1 ? '' : 'es'} in the conversation</span>${found.snippets
            .map((sn) => `<div class="hit" data-hit-key="${s.key}" data-hit-idx="${sn.idx}"><span class="hit-role ${sn.role}">${sn.role === 'user' ? 'you' : 'agent'}</span>${escapeHtml(sn.text)}</div>`)
            .join('')}</div>`
        : ''
      const row = `<tr class="${checked ? 'selected' : ''}" data-key="${s.key}">
        <td class="col-check"><input type="checkbox" data-key="${s.key}" ${checked}></td>
        <td class="col-expand"><button class="expander ${open ? 'open' : ''}" data-expand="${s.key}" title="Show conversation">▶</button></td>
        <td>
          <div class="title"><span class="tag ${s.agent}">${s.agent}</span>${escapeHtml(s.title)}</div>
          <div class="meta">
            <code class="sid">${escapeHtml(s.id)}</code><button class="copy-id" data-copy="${escapeHtml(s.id)}" title="Copy session id">⧉</button>
            ${escapeHtml(s.cwd || s.project || '')}${sharedNote ? ` · ${escapeHtml(sharedNote)}` : ''}
          </div>
          ${hits}
        </td>
        <td>${renderMachineBadge(s)}</td>
        <td><span class="state ${s.status}">${STATE_LABEL[s.status]}</span></td>
        <td class="num">${formatMessages(s.messages)}</td>
        <td class="num">${formatSize(s.size)}</td>
        <td>${formatWhen(s.updatedAt)}</td>
      </tr>`

      if (!open) return row
      return `${row}<tr class="detail-row"><td colspan="8">${renderTranscript(s)}</td></tr>`
    })
    .join('')

  $('rows').innerHTML = rows
  const cs = state.contentSearch
  const status = $('search-status')
  if (status) {
    if (cs.running) status.textContent = 'Searching every transcript…'
    else if (cs.query && cs.results) {
      const n = Object.keys(cs.results).length
      status.textContent = `${n} session${n === 1 ? '' : 's'} contain "${cs.query}"${cs.took ? ` · ${cs.took} ms` : ''}`
    } else status.textContent = ''
  }
  $('empty').hidden = sessions.length > 0
  $('select-all').checked = sessions.length > 0 && sessions.every((s) => state.selected.has(s.key))
  renderActionBar()
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function selectedSessions() {
  return state.data.sessions.filter((s) => state.selected.has(s.key))
}

function renderActionBar() {
  const chosen = selectedSessions()
  $('actionbar').hidden = chosen.length === 0
  $('selection-count').textContent = `${chosen.length} selected`

  const has = (fn) => chosen.some(fn)
  $('actionbar').querySelector('[data-action="push"]').disabled = !has((s) => s.locationId !== 'shared')
  $('actionbar').querySelector('[data-action="pull"]').disabled = !has((s) => s.shared)
  $('actionbar').querySelector('[data-action="rename"]').disabled = chosen.filter((s) => s.shared).length !== 1
  $('actionbar').querySelector('[data-action="delete-shared"]').disabled = !has((s) => s.shared)
}

function renderLocationFilter() {
  const select = $('filter-location')
  const options = state.data.locations.map((l) => `<option value="${l.id}">${escapeHtml(l.label)}</option>`).join('')
  select.innerHTML = `<option value="">All locations</option>${options}<option value="shared">OneDrive only</option>`
  select.value = state.filters.location
}

function renderLastRefresh() {
  const el = $('last-refresh')
  if (!el) return
  if (!state.lastRefresh) {
    el.textContent = ''
    return
  }
  const secs = Math.round((Date.now() - state.lastRefresh) / 1000)
  const text = secs < 5 ? 'refreshed just now' : secs < 60 ? `refreshed ${secs}s ago` : `refreshed ${Math.round(secs / 60)}m ago`
  el.textContent = text
}

async function load() {
  $('subtitle').textContent = 'Scanning…'
  try {
    state.data = await api('/api/scan')
    state.lastRefresh = Date.now()
    const shared = state.data.shared
    $('subtitle').textContent = `${state.data.locations.length} locations · shared: ${shared.claude ? 'claude-sessions' : 'no claude folder'}, ${
      shared.codex ? 'codex/sessions' : 'no codex folder'
    }`
    const live = new Set(state.data.sessions.map((s) => s.key))
    for (const key of [...state.selected]) if (!live.has(key)) state.selected.delete(key)
    for (const key of [...state.transcripts.keys()]) if (!live.has(key)) state.transcripts.delete(key)
    if (state.expanded && !live.has(state.expanded)) state.expanded = null
    renderStats()
    renderLocationFilter()
    renderRows()
    renderLastRefresh()
  } catch (err) {
    $('subtitle').textContent = 'Scan failed'
    toast(err.message, true)
  }
}

/**
 * Resolves to null when cancelled, otherwise to the values read out of the
 * extra fields while they are still in the DOM.
 */
function showModal({ title, body, confirmLabel, extraHtml = '', danger = false, read = () => ({}) }) {
  return new Promise((resolve) => {
    $('modal-title').textContent = title
    $('modal-body').textContent = body
    $('modal-extra').innerHTML = extraHtml
    const confirm = $('modal-confirm')
    confirm.textContent = confirmLabel
    confirm.className = danger ? 'btn danger' : 'btn primary'
    $('modal').hidden = false

    const close = (result) => {
      $('modal').hidden = true
      $('modal-extra').innerHTML = ''
      confirm.onclick = null
      $('modal-cancel').onclick = null
      resolve(result)
    }
    confirm.onclick = () => close(read())
    $('modal-cancel').onclick = () => close(null)
  })
}

function summarise(results) {
  const ok = results.filter((r) => r.ok && !r.skipped).length
  const skipped = results.filter((r) => r.skipped)
  const failed = results.filter((r) => !r.ok)
  let message = `${ok} of ${results.length} done.`
  if (skipped.length) message += `\n${skipped.length} skipped (already present — tick overwrite to replace).`
  if (failed.length) message += `\n${failed.length} failed: ${failed[0].error}`
  return { message, isError: failed.length > 0 }
}

async function runAction(action) {
  const chosen = selectedSessions()

  if (action === 'push') {
    const targets = chosen.filter((s) => s.locationId !== 'shared')
    const confirmed = await showModal({
      title: 'Sync to OneDrive',
      body: `Copy ${targets.length} session(s) to the shared folder. Sessions already saved there are updated in place.`,
      confirmLabel: 'Sync',
    })
    if (!confirmed) return
    const { results } = await api('/api/push', { sessions: targets })
    const { message, isError } = summarise(results)
    toast(message, isError)
  }

  if (action === 'pull') {
    const targets = chosen.filter((s) => s.shared)
    const agents = new Set(targets.map((s) => s.agent))
    const options = state.data.locations
      .filter((l) => agents.has(l.agent) && !l.readOnly)
      .map((l) => `<option value="${l.id}">${escapeHtml(l.label)}</option>`)
      .join('')
    if (!options) return toast('No local location matches the agent of the selected sessions.', true)

    const result = await showModal({
      title: 'Restore from OneDrive',
      body: `Copy ${targets.length} session(s) from the shared folder into a local location.`,
      confirmLabel: 'Restore',
      extraHtml: `<label>Restore into<select id="pull-target">${options}</select></label>
        <label class="check"><input type="checkbox" id="pull-overwrite"> Overwrite existing local files</label>`,
      read: () => ({ targetLocationId: $('pull-target').value, overwrite: $('pull-overwrite').checked }),
    })
    if (!result) return
    const { targetLocationId, overwrite } = result
    const { results } = await api('/api/pull', { sessions: targets, targetLocationId, overwrite })
    const { message, isError } = summarise(results)
    toast(message, isError)
  }

  if (action === 'rename') {
    const target = chosen.find((s) => s.shared)
    if (!target) return toast('Only sessions saved to OneDrive can be renamed.', true)
    if (chosen.filter((s) => s.shared).length > 1) return toast('Select a single session to rename.', true)

    const result = await showModal({
      title: 'Rename saved conversation',
      body: `This renames the folder in the shared OneDrive folder. The local transcript keeps its session id as its filename.`,
      confirmLabel: 'Rename',
      extraHtml: `<label>New name<input id="rename-input" type="text" value="${escapeHtml(target.shared.name)}"></label>`,
      read: () => ({ name: $('rename-input').value }),
    })
    if (!result) return
    const renamed = await api('/api/rename', { session: target, name: result.name })
    toast(`Renamed to "${renamed.name}".`)
  }

  if (action === 'delete-shared') {
    const targets = chosen.filter((s) => s.shared)
    const confirmed = await showModal({
      title: 'Delete from OneDrive',
      body: `Permanently delete ${targets.length} saved conversation(s) from the shared folder. This removes them from every machine once OneDrive syncs.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!confirmed) return
    const { results } = await api('/api/delete-shared', { sessions: targets })
    const { message, isError } = summarise(results)
    toast(message, isError)
  }

  state.selected.clear()
  await load()
}

/** Remove any highlight spans left over from a previous jump. */
function clearMatchMarks() {
  for (const mark of document.querySelectorAll('mark.hit-mark')) {
    const parent = mark.parentNode
    if (!parent) continue
    parent.replaceChild(document.createTextNode(mark.textContent), mark)
    parent.normalize()
  }
}

/**
 * Wrap every occurrence of `needle` inside `el` in a <mark>. Walks text nodes
 * rather than touching innerHTML, so existing markup (code, tables, links)
 * cannot be corrupted by the replacement.
 */
function markMatches(el, needle) {
  if (!needle) return 0
  const target = needle.toLowerCase()
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const nodes = []
  let node
  while ((node = walker.nextNode())) {
    if (node.nodeValue.toLowerCase().includes(target)) nodes.push(node)
  }

  let count = 0
  for (const text of nodes) {
    let rest = text
    for (;;) {
      const at = rest.nodeValue.toLowerCase().indexOf(target)
      if (at === -1) break
      const after = rest.splitText(at)
      const tail = after.splitText(target.length)
      const mark = document.createElement('mark')
      mark.className = 'hit-mark'
      mark.textContent = after.nodeValue
      after.parentNode.replaceChild(mark, after)
      count += 1
      rest = tail
    }
  }
  return count
}

function scrollToMessage(key, idx) {
  const doScroll = (attempt) => {
    const el = document.querySelector(`[data-msg-idx="${idx}"]`)
    if (!el) {
      if (attempt < 5) {
        setTimeout(() => doScroll(attempt + 1), 100)
        return
      }
      // Very long conversations only load their head and tail; a hit in between
      // has nothing to scroll to, so say so rather than appearing to do nothing.
      const entry = state.transcripts.get(key)
      if (entry?.dropped) {
        toast(`That match is inside the ${entry.dropped} messages omitted from the middle of this conversation.`, true)
      }
      return
    }
    document.querySelectorAll('.msg-highlight').forEach((e) => e.classList.remove('msg-highlight'))
    clearMatchMarks()
    markMatches(el, state.contentSearch.query)
    const container = el.closest('.transcript')
    if (container && container.scrollHeight > container.clientHeight) {
      const elTop = el.getBoundingClientRect().top
      const cTop = container.getBoundingClientRect().top
      container.scrollTop += elTop - cTop - 40
    } else {
      el.scrollIntoView({ block: 'center' })
    }
    el.classList.add('msg-highlight')
    setTimeout(() => {
      el.classList.remove('msg-highlight')
      document.querySelectorAll('mark.hit-mark').forEach((m) => m.classList.add('fading'))
      setTimeout(clearMatchMarks, 600)
    }, 4000)
  }
  setTimeout(() => doScroll(0), 0)
}

async function toggleExpand(key, scrollToIdx) {
  if (state.expanded === key && scrollToIdx == null) {
    state.expanded = null
    return renderRows()
  }
  state.expanded = key
  renderRows()

  if (!state.transcripts.has(key)) {
    const session = state.data.sessions.find((s) => s.key === key)
    try {
      state.transcripts.set(key, await api('/api/transcript', { session }))
    } catch (err) {
      state.transcripts.set(key, { error: err.message })
    }
    if (state.expanded === key) renderRows()
  }
  if (scrollToIdx != null) scrollToMessage(key, scrollToIdx)
}

async function copyId(id, button) {
  try {
    await navigator.clipboard.writeText(id)
  } catch {
    // Clipboard API can be blocked; fall back to a temporary selection.
    const field = document.createElement('textarea')
    field.value = id
    document.body.appendChild(field)
    field.select()
    document.execCommand('copy')
    field.remove()
  }
  button.textContent = '✓'
  setTimeout(() => {
    button.textContent = '⧉'
  }, 1200)
}

$('rows').addEventListener('click', (event) => {
  const hit = event.target.closest('[data-hit-key]')
  if (hit) {
    const key = hit.dataset.hitKey
    const idx = Number(hit.dataset.hitIdx)
    toggleExpand(key, idx).catch((err) => toast(err.message, true))
    return
  }

  const copy = event.target.closest('[data-copy]')
  if (copy) {
    copyId(copy.dataset.copy, copy).catch(() => toast('Could not copy to the clipboard.', true))
    return
  }

  const expander = event.target.closest('[data-expand]')
  if (expander) {
    toggleExpand(expander.dataset.expand).catch((err) => toast(err.message, true))
    return
  }

  // Only the checkbox (or its cell) changes the selection — clicking the title,
  // path or any other cell must leave it alone.
  const cell = event.target.closest('td.col-check')
  if (!cell) return
  const row = cell.closest('tr[data-key]')
  if (!row) return
  const key = row.dataset.key
  if (state.selected.has(key)) state.selected.delete(key)
  else state.selected.add(key)
  renderRows()
})

$('select-all').addEventListener('change', (event) => {
  for (const s of visibleSessions()) {
    if (event.target.checked) state.selected.add(s.key)
    else state.selected.delete(s.key)
  }
  renderRows()
})

$('clear-selection').addEventListener('click', () => {
  state.selected.clear()
  renderRows()
})

$('actionbar').addEventListener('click', (event) => {
  const action = event.target.dataset.action
  if (action) runAction(action).catch((err) => toast(err.message, true))
})

let searchTimer = null
let searchToken = 0

async function runContentSearch(needle) {
  const token = ++searchToken
  state.contentSearch.running = true
  renderRows()
  try {
    const found = await api('/api/search', { q: needle })
    if (token !== searchToken) return // a newer query already went out
    state.contentSearch = { query: needle, results: found.results, running: false, took: found.took }
  } catch {
    if (token !== searchToken) return
    state.contentSearch = { query: needle, results: {}, running: false }
  }
  renderRows()
}

$('search').addEventListener('input', (e) => {
  const value = e.target.value
  state.filters.search = value
  const needle = value.trim().toLowerCase()

  clearTimeout(searchTimer)
  if (needle.length < 2) {
    searchToken++
    state.contentSearch = { query: '', results: null, running: false }
    renderRows()
    return
  }
  renderRows()
  // Scanning every transcript costs about a second, so wait for a pause in typing.
  searchTimer = setTimeout(() => runContentSearch(needle), 350)
})
for (const [id, key] of [['filter-agent', 'agent'], ['filter-location', 'location'], ['filter-status', 'status']]) {
  $(id).addEventListener('change', (e) => {
    state.filters[key] = e.target.value
    renderRows()
  })
}
$('detailed-view').addEventListener('change', (e) => {
  state.detailedView = e.target.checked
  savePref('detailedView', state.detailedView)
  renderRows()
})

$('hide-subagents').addEventListener('change', (e) => {
  state.hideSubagents = e.target.checked
  renderRows()
})
$('refresh').addEventListener('click', load)

$('detailed-view').checked = state.detailedView
load()
setInterval(renderLastRefresh, 5000)
