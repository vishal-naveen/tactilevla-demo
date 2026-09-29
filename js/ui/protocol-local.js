// Local copy of js/stage/protocol.js semantics (CONTRACT). Used only if the real module is absent.
export const CELLS = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3'];
export const HELD_OUT = 'B2';
export const PERIMETER = ['A1', 'B1', 'C1', 'C2', 'C3', 'B3', 'A3', 'A2'];
export const TOTAL_EPISODES = 160;

const PER_CELL = 5;
const PER_ROUND = PERIMETER.length * PER_CELL; // 40

function cellOf(index) {
  const round = Math.floor(index / PER_ROUND);
  const slot = Math.floor((index % PER_ROUND) / PER_CELL);
  const order = round % 2 === 1 ? [...PERIMETER].reverse() : PERIMETER;
  return { cell: order[slot], round: round + 1 };
}

export function episodeAt(k) {
  const count = Math.round(Math.min(1, Math.max(0, k)) * TOTAL_EPISODES);
  if (count === 0) return { count: 0, index: -1, cell: null, round: null };
  const { cell, round } = cellOf(count - 1);
  return { count, index: count - 1, cell, round };
}

export function episodesPerCell(count) {
  const out = Object.fromEntries(CELLS.map((c) => [c, 0]));
  for (let i = 0; i < Math.min(count, TOTAL_EPISODES); i++) out[cellOf(i).cell] += 1;
  return out;
}
