const state = {
  data: null,
  selected: new Set(),
  filters: { search: '', agent: '', location: '', status: '' },
  hideSubagents: true,
  expanded: null,
  transcripts: new Map(),
}

const $ = (id) => document.getElementById(id)

const STATE_LABEL = {
  synced: 'Synced',
  'local-only': 'Not synced',
  'local-newer': 'Local ahead',
  'remote-newer': 'OneDrive ahead',
  'remote-only': 'OneDrive only',
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
    return [s.title, s.cwd, s.id, s.project, s.locationLabel].filter(Boolean).join(' ').toLowerCase().includes(needle)
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
    <div class="stat"><b>${state.data.locations.length}</b><span>locations</span></div>`
}

function renderMessage(m) {
  if (m.role === 'meta') return `<div class="msg meta-msg">${escapeHtml(m.text)}</div>`
  if (m.role === 'tool-result') return `<div class="msg tool-result"><pre>${escapeHtml(m.text)}</pre></div>`

  const parts = (m.parts || [])
    .map((p) => {
      if (p.kind === 'text') return `<div class="part">${escapeHtml(p.text)}</div>`
      if (p.kind === 'thinking') return `<div class="part thinking">${escapeHtml(p.text)}</div>`
      return `<div class="part tool"><b>${escapeHtml(p.text)}</b> <span>${escapeHtml(p.detail || '')}</span></div>`
    })
    .join('')

  return `<div class="msg ${m.role}">
    <div class="who">${m.role === 'user' ? 'You' : 'Assistant'}${m.at ? ` · ${new Date(m.at).toLocaleString()}` : ''}</div>
    ${parts}
  </div>`
}

function renderTranscript(session) {
  const entry = state.transcripts.get(session.key)
  if (!entry) return '<div class="transcript loading">Loading transcript…</div>'
  if (entry.error) return `<div class="transcript error-text">${escapeHtml(entry.error)}</div>`

  const gap = entry.dropped
    ? `<div class="msg meta-msg">… ${entry.dropped} messages in the middle not shown (${entry.total} total) …</div>`
    : ''
  const body = entry.messages.map(renderMessage)
  if (gap) body.splice(60, 0, gap)

  return `<div class="transcript">
    <div class="transcript-head">
      <span>${entry.total} messages · ${formatSize(entry.bytes)} · <code class="sid">${escapeHtml(session.id)}</code><button class="copy-id" data-copy="${escapeHtml(session.id)}" title="Copy session id">⧉</button></span>
      <span class="path">${escapeHtml(session.file)}</span>
    </div>
    ${body.join('') || '<div class="loading">Nothing readable in this transcript.</div>'}
  </div>`
}

function renderRows() {
  const sessions = visibleSessions()
  const rows = sessions
    .map((s) => {
      const checked = state.selected.has(s.key) ? 'checked' : ''
      const open = state.expanded === s.key
      const sharedNote = s.shared ? `OneDrive: ${s.shared.name}` : ''
      const row = `<tr class="${checked ? 'selected' : ''}" data-key="${s.key}">
        <td class="col-check"><input type="checkbox" data-key="${s.key}" ${checked}></td>
        <td class="col-expand"><button class="expander ${open ? 'open' : ''}" data-expand="${s.key}" title="Show conversation">▶</button></td>
        <td>
          <div class="title"><span class="tag ${s.agent}">${s.agent}</span>${escapeHtml(s.title)}</div>
          <div class="meta">
            <code class="sid">${escapeHtml(s.id)}</code><button class="copy-id" data-copy="${escapeHtml(s.id)}" title="Copy session id">⧉</button>
            ${escapeHtml(s.cwd || s.project || '')}${sharedNote ? ` · ${escapeHtml(sharedNote)}` : ''}
          </div>
        </td>
        <td>${escapeHtml(s.locationLabel)}</td>
        <td><span class="state ${s.status}">${STATE_LABEL[s.status]}</span></td>
        <td class="num">${formatSize(s.size)}</td>
        <td>${formatWhen(s.updatedAt)}</td>
      </tr>`

      if (!open) return row
      return `${row}<tr class="detail-row"><td colspan="7">${renderTranscript(s)}</td></tr>`
    })
    .join('')

  $('rows').innerHTML = rows
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
  $('actionbar').querySelector('[data-action="delete-local"]').disabled = !has((s) => s.locationId !== 'shared')
  $('actionbar').querySelector('[data-action="delete-shared"]').disabled = !has((s) => s.shared)
}

function renderLocationFilter() {
  const select = $('filter-location')
  const options = state.data.locations.map((l) => `<option value="${l.id}">${escapeHtml(l.label)}</option>`).join('')
  select.innerHTML = `<option value="">All locations</option>${options}<option value="shared">OneDrive only</option>`
  select.value = state.filters.location
}

async function load() {
  $('subtitle').textContent = 'Scanning…'
  try {
    state.data = await api('/api/scan')
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
      .filter((l) => agents.has(l.agent))
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

  if (action === 'delete-local') {
    const targets = chosen.filter((s) => s.locationId !== 'shared')
    const unsynced = targets.filter((s) => s.status === 'local-only' || s.status === 'local-newer')
    const warning = unsynced.length ? ` ${unsynced.length} of them are not fully backed up to OneDrive and will be lost.` : ''
    const confirmed = await showModal({
      title: 'Delete local copies',
      body: `Permanently delete ${targets.length} transcript file(s) from this machine.${warning} The OneDrive copies stay.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!confirmed) return
    const { results } = await api('/api/delete-local', { sessions: targets })
    const { message, isError } = summarise(results)
    toast(message, isError)
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

async function toggleExpand(key) {
  if (state.expanded === key) {
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

  const row = event.target.closest('tr[data-key]')
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

$('search').addEventListener('input', (e) => {
  state.filters.search = e.target.value
  renderRows()
})
for (const [id, key] of [['filter-agent', 'agent'], ['filter-location', 'location'], ['filter-status', 'status']]) {
  $(id).addEventListener('change', (e) => {
    state.filters[key] = e.target.value
    renderRows()
  })
}
$('hide-subagents').addEventListener('change', (e) => {
  state.hideSubagents = e.target.checked
  renderRows()
})
$('refresh').addEventListener('click', load)

load()
