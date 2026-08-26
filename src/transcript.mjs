import fs from 'node:fs'
import readline from 'node:readline'

const HEAD_KEEP = 60
const TAIL_KEEP = 300

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') return part.text || ''
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function clip(text, max = 600) {
  const t = String(text ?? '')
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** One line per record type we care about; everything else is dropped. */
function claudeMessage(rec) {
  if (rec.isSidechain) return null

  if (rec.type === 'system' && rec.subtype === 'local_command') {
    const name = /<command-name>(.*?)<\/command-name>/s.exec(rec.content || '')?.[1]?.trim()
    return name ? { role: 'meta', text: name, at: rec.timestamp } : null
  }

  if (rec.type !== 'user' && rec.type !== 'assistant') return null
  const content = rec.message?.content ?? rec.content
  const parts = []
  let toolResult = null

  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === 'text' && part.text?.trim()) parts.push({ kind: 'text', text: part.text })
      else if (part?.type === 'thinking' && part.thinking?.trim()) parts.push({ kind: 'thinking', text: clip(part.thinking, 1200) })
      else if (part?.type === 'tool_use') parts.push({ kind: 'tool', text: part.name, detail: clip(JSON.stringify(part.input), 400) })
      else if (part?.type === 'tool_result') toolResult = clip(textOf(part.content), 400)
    }
  } else if (typeof content === 'string' && content.trim()) {
    parts.push({ kind: 'text', text: content })
  }

  // A user record carrying only a tool_result is the transcript's plumbing, not a turn.
  if (!parts.length) return toolResult ? { role: 'tool-result', text: toolResult, at: rec.timestamp } : null

  return { role: rec.type, parts, at: rec.timestamp, model: rec.message?.model || null }
}

function codexMessage(rec) {
  const p = rec.payload || {}

  if (rec.type === 'response_item') {
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = textOf(p.content)
      if (!text.trim()) return null
      return { role: p.role, parts: [{ kind: 'text', text }], at: rec.timestamp }
    }
    if (p.type === 'function_call' || p.type === 'local_shell_call') {
      return {
        role: 'assistant',
        parts: [{ kind: 'tool', text: p.name || 'shell', detail: clip(p.arguments || JSON.stringify(p.action || {}), 400) }],
        at: rec.timestamp,
      }
    }
    if (p.type === 'function_call_output' || p.type === 'local_shell_call_output') {
      return { role: 'tool-result', text: clip(textOf(p.output?.content ?? p.output), 400), at: rec.timestamp }
    }
    if (p.type === 'reasoning') {
      const text = (p.summary || []).map((s) => s?.text || '').filter(Boolean).join('\n')
      if (!text.trim()) return null
      return { role: 'assistant', parts: [{ kind: 'thinking', text: clip(text, 1200) }], at: rec.timestamp }
    }
  }
  return null
}

/**
 * Streams a transcript and returns a readable message list. Very long
 * conversations keep their opening and their tail, with a gap marker between.
 */
export async function readTranscript(file, agent) {
  const stat = fs.statSync(file)
  const stream = fs.createReadStream(file, { encoding: 'utf8' })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })

  const head = []
  const tail = []
  let dropped = 0
  let total = 0

  for await (const line of lines) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const message = agent === 'claude' ? claudeMessage(rec) : codexMessage(rec)
    if (!message) continue
    total += 1

    if (head.length < HEAD_KEEP) head.push(message)
    else {
      tail.push(message)
      if (tail.length > TAIL_KEEP) {
        tail.shift()
        dropped += 1
      }
    }
  }

  return { messages: [...head, ...tail], total, dropped, bytes: stat.size }
}
