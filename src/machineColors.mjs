import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const COLORS_FILE = path.join(os.homedir(), '.session-manager-machine-colors.json')

/**
 * Light, friendly hues (pastel background + a readable matching text color),
 * picked so a small badge reads fine on both a light and a dark panel.
 * Order matters: new machines are assigned the next unused color in sequence.
 */
const PALETTE = [
  { bg: '#dbeafe', fg: '#1d4ed8' }, // blue
  { bg: '#dcfce7', fg: '#15803d' }, // green
  { bg: '#fef3c7', fg: '#b45309' }, // amber
  { bg: '#fce7f3', fg: '#be185d' }, // pink
  { bg: '#ede9fe', fg: '#6d28d9' }, // violet
  { bg: '#ccfbf1', fg: '#0f766e' }, // teal
  { bg: '#fee2e2', fg: '#b91c1c' }, // red
  { bg: '#e0f2fe', fg: '#0369a1' }, // sky
  { bg: '#fae8ff', fg: '#a21caf' }, // fuchsia
  { bg: '#ecfccb', fg: '#4d7c0f' }, // lime
]

function load() {
  try {
    return JSON.parse(fs.readFileSync(COLORS_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function save(map) {
  try {
    fs.writeFileSync(COLORS_FILE, JSON.stringify(map, null, 2))
  } catch {
    /* best effort; colors just get re-picked next time */
  }
}

/**
 * Stable host -> {bg, fg} color mapping, persisted to a JSON file next to the
 * session cache. Each machine keeps its color for as long as the file exists;
 * a newly-seen host gets the next unused palette entry (colors are recycled
 * once the palette is exhausted).
 */
export function machineColors(hosts) {
  const map = load()
  let changed = false

  const used = new Set(Object.values(map).map((c) => c.bg))
  for (const host of hosts) {
    if (map[host]) continue
    const next = PALETTE.find((c) => !used.has(c.bg)) || PALETTE[Object.keys(map).length % PALETTE.length]
    map[host] = next
    used.add(next.bg)
    changed = true
  }

  if (changed) save(map)

  // Only return colors for hosts actually in play, so the payload stays small.
  const result = {}
  for (const host of hosts) result[host] = map[host]
  return result
}
