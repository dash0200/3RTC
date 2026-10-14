/**
 * Board geometry: a 15 x 15 grid. Bases in the corners (red top-left, green top-right, yellow
 * bottom-right, blue bottom-left), the 52-square track around the cross, a 5-square home column
 * per colour, home in the middle. Coordinates are cell centres in grid units.
 */
import { COLORS, START, LAST_TRACK, HOME } from './rules';

// The track, starting at red's start square and going clockwise (52 squares)
const run = (x0, y0, dx, dy, n) => Array.from({ length: n }, (_, i) => [x0 + dx * i, y0 + dy * i]);
export const TRACK = [
    ...run(1, 6, 1, 0, 5),   // red start, along the left arm
    ...run(6, 5, 0, -1, 6),  // up the top arm
    [7, 0],
    ...run(8, 0, 0, 1, 6),   // down the top arm (green start at (8,1))
    ...run(9, 6, 1, 0, 6),   // along the right arm
    [14, 7],
    ...run(14, 8, -1, 0, 6), // back along the right arm (yellow start at (13,8))
    ...run(8, 9, 0, 1, 6),   // down the bottom arm
    [7, 14],
    ...run(6, 14, 0, -1, 6), // up the bottom arm (blue start at (6,13))
    ...run(5, 8, -1, 0, 6),  // back along the left arm
    [0, 7],
    [0, 6]
];

const HOME_COLUMN = {
    red: run(1, 7, 1, 0, 5),
    green: run(7, 1, 0, 1, 5),
    yellow: run(13, 7, -1, 0, 5),
    blue: run(7, 13, 0, -1, 5)
};

// Where finished tokens sit: in the colour's triangle of the centre square (2 x 2, small)
const HOME_SPOT = { red: [6.55, 7.5], green: [7.5, 6.55], yellow: [8.45, 7.5], blue: [7.5, 8.45] };
const HOME_OFFSETS = [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]];

// Base corners (top-left cell of the 6 x 6 base)
export const BASE_ORIGIN = { red: [0, 0], green: [9, 0], yellow: [9, 9], blue: [0, 9] };
const BASE_SLOTS = [[1.9, 1.9], [4.1, 1.9], [1.9, 4.1], [4.1, 4.1]];

export const center = ([x, y]) => [x + 0.5, y + 0.5];

/** Centre point (grid units) of a token of `color`, number `index`, at `progress`. */
export function tokenPoint(color, index, progress) {
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

/** Squares to colour in: home columns, start squares, star squares. */
export function coloredSquares() {
    const cells = [];
    for (const color of COLORS) {
        for (const cell of HOME_COLUMN[color]) cells.push({ cell, color });
        cells.push({ cell: TRACK[START[color]], color, start: true });
        cells.push({ cell: TRACK[(START[color] + 8) % TRACK.length], star: true });
    }
    return cells;
}

/** The squares a token passes through from `from` to `to` (for the hop animation). */
export function pathOf(from, to) {
    if (from === -1) return [0];
    const steps = [];
    for (let p = from + 1; p <= to; p++) steps.push(p);
    return steps;
}
