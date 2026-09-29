// Recording protocol shared with the page: pure functions, no DOM, no three.js.
export const CELLS = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3']
export const HELD_OUT = 'B2'
export const PERIMETER = ['A1', 'B1', 'C1', 'C2', 'C3', 'B3', 'A3', 'A2']
export const TOTAL_EPISODES = 160
// The data chapter's scrub fills all 160 episodes by this fraction of the pin, then holds the complete picture.
// Stage and page both map count = episodeAt(min(1, p / DATA_FILL_END)).count.
export const DATA_FILL_END = 0.55

const ROUNDS = 4
const PER_CELL = 5
const PER_ROUND = PERIMETER.length * PER_CELL // 40

// Cell visited by 0-based episode number e (0..159), plus which round it belongs to.
function episodeInfo(e) {
  const round = Math.floor(e / PER_ROUND) // 0..3
  const within = e % PER_ROUND
  const slot = Math.floor(within / PER_CELL)
  const order = round % 2 === 1 ? [...PERIMETER].reverse() : PERIMETER
  return { cell: order[slot], round: round + 1 }
}

// k in [0,1] -> how many of the 160 episodes are recorded at scrub position k, and the latest one.
export function episodeAt(k) {
  const kk = Math.min(1, Math.max(0, Number.isFinite(k) ? k : 0))
  const count = Math.round(kk * TOTAL_EPISODES)
  if (count <= 0) return { count: 0, index: -1, cell: null, round: null }
  const { cell, round } = episodeInfo(count - 1)
  return { count, index: count - 1, cell, round }
}

// Episodes recorded per cell after `count` episodes. B2 is always 0 (held out).
export function episodesPerCell(count) {
  const out = Object.fromEntries(CELLS.map((c) => [c, 0]))
  const n = Math.min(TOTAL_EPISODES, Math.max(0, Math.floor(count) || 0))
  for (let e = 0; e < n; e++) out[episodeInfo(e).cell] += 1
  return out
}

// Cell of a specific 0-based episode number (used by the 3D grid for arcs and dot order).
export function cellOfEpisode(e) {
  return episodeInfo(e).cell
}
