/**
 * Chess pieces as vector shapes, "geometric" style: bold flat shapes, White pieces light with a
 * dark outline, Black pieces solid with light details. Drawn in a 100 x 100 box; the board scales
 * them. Parts are filled in order, so later parts (band, base) sit on top of earlier ones.
 */
import type { JSX } from 'react';
import type { ChessColor } from './engine';

const circle = (cx: number, cy: number, r: number): string =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;

const BASE = 'M25 78H75a3 3 0 0 1 3 3V86a3 3 0 0 1-3 3H25a3 3 0 0 1-3-3V81a3 3 0 0 1 3-3Z';
const STEM = 'M34 65H66L70 78H30Z';
const BAND = (y: number, x1 = 29, x2 = 71, h = 7): string => `M${x1} ${y}H${x2}V${y + h}H${x1}Z`;

interface Shape {
  /** filled and outlined, in drawing order */
  parts: string[];
  /** contrast strokes: dark on White, light on Black */
  details?: string[];
}

export const PIECE_SHAPES: Record<string, Shape> = {
  p: {
    parts: ['M40 50H60L68 78H32Z', BAND(43, 35, 65, 8), circle(50, 28, 13.5), BASE]
  },
  r: {
    parts: [
      'M32 48H68L71 78H29Z',
      'M26 15H36V23H44V15H56V23H64V15H74V42H26Z',
      BAND(42, 29, 71, 7),
      BASE
    ],
    details: ['M33 32H67']
  },
  n: {
    parts: [
      'M30 78L33 62C34 54 41 49 47 44L37 48C30 50 24 48 22 43L21 37.5L38 22L41.5 11L49.5 19C65 19.5 77 33 77 51L74 78Z',
      BASE
    ],
    details: [circle(43, 31, 2.6), 'M55 27L62 40']
  },
  b: {
    parts: [
      'M41 61H59L66 78H34Z',
      circle(50, 13, 6),
      'M50 19C64 28 69 43 61 54H39C31 43 36 28 50 19Z',
      BAND(54, 35, 65, 7),
      BASE
    ],
    details: ['M55 28L45 44']
  },
  q: {
    parts: [
      STEM,
      circle(22, 24, 4.5),
      circle(36, 15, 4.5),
      circle(50, 12, 4.5),
      circle(64, 15, 4.5),
      circle(78, 24, 4.5),
      'M28 58L22 28L36 43L37 19L50 39L63 19L64 43L78 28L72 58Z',
      BAND(58),
      BASE
    ],
    details: ['M34 51H66']
  },
  k: {
    parts: [
      STEM,
      'M46.5 4H53.5V10.5H60V17H53.5V29H46.5V17H40V10.5H46.5Z',
      'M50 28C57 28 60 33 59 38C66 31 80 33 78.5 44C77.5 51 72.5 55 72 58H28C27.5 55 22.5 51 21.5 44C20 33 34 31 41 38C40 33 43 28 50 28Z',
      BAND(58),
      BASE
    ],
    details: ['M50 40V56', 'M31 50C40 46 60 46 69 50']
  }
};

const INK = '#1f2420';
const PAPER = '#fbfaf3';
const LIGHT_DETAIL = '#e7e8d4';

export const PIECE_STYLE: Record<ChessColor, { fill: string; stroke: string; detail: string }> = {
  w: { fill: PAPER, stroke: INK, detail: INK },
  b: { fill: INK, stroke: INK, detail: LIGHT_DETAIL }
};

export interface PieceProps {
  /** p n b r q k */
  type: string;
  color: ChessColor;
  /** top-left corner and size in the parent SVG's units */
  x?: number;
  y?: number;
  size?: number;
  className?: string;
}

/** One piece as SVG; place it inside an <svg>. */
export function Piece({ type, color, x = 0, y = 0, size = 100, className }: PieceProps): JSX.Element | null {
  const shape = PIECE_SHAPES[type];
  if (!shape) return null;
  const style = PIECE_STYLE[color];
  return (
    <g
      className={className}
      transform={`translate(${x} ${y}) scale(${size / 100})`}
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      {shape.parts.map((d, i) => (
        <path key={i} d={d} fill={style.fill} stroke={style.stroke} strokeWidth={3.4} />
      ))}
      {shape.details?.map((d, i) => (
        <path key={`d${i}`} d={d} fill={d.endsWith('Z') ? style.detail : 'none'} stroke={style.detail} strokeWidth={3.4} />
      ))}
    </g>
  );
}

/** A standalone piece icon (captured pieces, promotion choices). */
export function PieceIcon({ type, color, className }: { type: string; color: ChessColor; className?: string }): JSX.Element {
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden="true">
      <Piece type={type} color={color} />
    </svg>
  );
}
