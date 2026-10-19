/**
 * Board geometry: a 15 x 15 grid. Bases in the corners (red top-left, green top-right, yellow
 * bottom-right, blue bottom-left), the 52-square track around the cross, a 5-square home column
 * per colour, home in the middle. Coordinates are cell centres in grid units.
 */
import { COLORS, START, LAST_TRACK, HOME, type LudoColor } from './rules';

export type GridPoint = [number, number];

// The track, starting at red's start square and going clockwise (52 squares)
const run = (x0: number, y0: number, dx: number, dy: number, n: number): GridPoint[] =>
  Array.from({ length: n }, (_, i) => [x0 + dx * i, y0 + dy * i]);

export const TRACK: GridPoint[] = [
  ...run(1, 6, 1, 0, 5), // red start, along the left arm
  ...run(6, 5, 0, -1, 6), // up the top arm
  [7, 0],
  ...run(8, 0, 0, 1, 6), // down the top arm (green start at (8,1))
  ...run(9, 6, 1, 0, 6), // along the right arm
  [14, 7],
  ...run(14, 8, -1, 0, 6), // back along the right arm (yellow start at (13,8))
  ...run(8, 9, 0, 1, 6), // down the bottom arm
  [7, 14],
  ...run(6, 14, 0, -1, 6), // up the bottom arm (blue start at (6,13))
  ...run(5, 8, -1, 0, 6), // back along the left arm
  [0, 7],
  [0, 6]
];

const HOME_COLUMN: Record<LudoColor, GridPoint[]> = {
  red: run(1, 7, 1, 0, 5),
  green: run(7, 1, 0, 1, 5),
  yellow: run(13, 7, -1, 0, 5),
  blue: run(7, 13, 0, -1, 5)
};

// Where finished tokens sit: in the colour's triangle of the centre square (2 x 2, small)
const HOME_SPOT: Record<LudoColor, GridPoint> = {
  red: [6.55, 7.5],
  green: [7.5, 6.55],
  yellow: [8.45, 7.5],
  blue: [7.5, 8.45]
};
const HOME_OFFSETS: GridPoint[] = [
  [-0.2, -0.2],
  [0.2, -0.2],
  [-0.2, 0.2],
  [0.2, 0.2]
];

// Base corners (top-left cell of the 6 x 6 base)
export const BASE_ORIGIN: Record<LudoColor, GridPoint> = {
  red: [0, 0],
  green: [9, 0],
  yellow: [9, 9],
  blue: [0, 9]
};
const BASE_SLOTS: GridPoint[] = [
  [1.9, 1.9],
  [4.1, 1.9],
  [1.9, 4.1],
  [4.1, 4.1]
];

export const center = ([x, y]: GridPoint): GridPoint => [x + 0.5, y + 0.5];

/** Centre point (grid units) of a token of `color`, number `index`, at `progress`. */
export function tokenPoint(color: LudoColor, index: number, progress: number): GridPoint {
  if (progress === -1) {
    const [bx, by] = BASE_ORIGIN[color];
    const [sx, sy] = BASE_SLOTS[index];
    return [bx + sx, by + sy];
  }
  if (progress <= LAST_TRACK) return center(TRACK[(START[color] + progress) % TRACK.length]);
  if (progress < HOME) return center(HOME_COLUMN[color][progress - LAST_TRACK - 1]);
  const [hx, hy] = HOME_SPOT[color];
  const [ox, oy] = HOME_OFFSETS[index];
  return [hx + ox, hy + oy];
}

export interface ColoredSquare {
  cell: GridPoint;
  color?: LudoColor;
  start?: boolean;
  star?: boolean;
}

/** Squares to colour in: home columns, start squares, star squares. */
export function coloredSquares(): ColoredSquare[] {
  const cells: ColoredSquare[] = [];
  for (const color of COLORS) {
    for (const cell of HOME_COLUMN[color]) cells.push({ cell, color });
    cells.push({ cell: TRACK[START[color]], color, start: true });
    cells.push({ cell: TRACK[(START[color] + 8) % TRACK.length], star: true });
  }
  return cells;
}

/** The squares a token passes through from `from` to `to` (for the hop animation). */
export function pathOf(from: number, to: number): number[] {
  if (from === -1) return [0];
  const steps: number[] = [];
  for (let p = from + 1; p <= to; p++) steps.push(p);
  return steps;
}

// Offsets (in squares) for 1-4 tokens sharing a square, and their size
const STACK_SLOTS: Record<number, GridPoint[]> = {
  1: [[0, 0]],
  2: [
    [-0.25, 0],
    [0.25, 0]
  ],
  3: [
    [-0.23, -0.2],
    [0.23, -0.2],
    [0, 0.22]
  ],
  4: [
    [-0.23, -0.23],
    [0.23, -0.23],
    [-0.23, 0.23],
    [0.23, 0.23]
  ]
};
const STACK_RADIUS: Record<number, number> = { 1: 0.36, 2: 0.21, 3: 0.19, 4: 0.19 };

export interface PlacedToken {
  color: LudoColor;
  i: number;
  p: number;
  x: number;
  y: number;
  r: number;
}

/**
 * Where to draw every token: { color, i, p, x, y, r } in drawing order. Tokens sharing a square
 * are made smaller and spread out (side by side, or 2 x 2) so each stays visible and tappable;
 * tokens in `movable` (a Set of `${color}${index}`) are drawn last, on top of any others.
 */
export function placeTokens(
  shown: Record<LudoColor, number[] | null | undefined>,
  movable: Set<string> = new Set()
): PlacedToken[] {
  const groups = new Map<string, Array<{ color: LudoColor; i: number; p: number; pt: GridPoint }>>();
  for (const color of COLORS) {
    (shown[color] || []).forEach((p, i) => {
      const pt = tokenPoint(color, i, p);
      const key = p >= HOME || p === -1 ? `${color}${i}${p}` : pt.join(',');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ color, i, p, pt });
    });
  }
  const placed: PlacedToken[] = [];
  for (const group of groups.values()) {
    const n = Math.min(group.length, 4);
    group.forEach((t, k) => {
      const [dx, dy] = STACK_SLOTS[n]?.[k % 4] || [0, 0];
      placed.push({
        color: t.color,
        i: t.i,
        p: t.p,
        x: t.pt[0] + dx,
        y: t.pt[1] + dy,
        r: t.p >= HOME ? 0.17 : (STACK_RADIUS[n] || 0.2)
      });
    });
  }
  const top = (t: PlacedToken): number => Number(movable.has(`${t.color}${t.i}`));
  return placed.sort((a, b) => top(a) - top(b));
}
