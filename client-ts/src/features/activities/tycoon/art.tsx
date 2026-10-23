/**
 * Tycoon's vector art: space icons, player tokens, dice, houses and hotels, and the skyline in
 * the middle of the board. All drawn here as SVG.
 */
import type { JSX } from 'react';
import type { TokenId } from './board';

const INK = '#23252d';

/** Icons in a 40 × 40 box, drawn at (x, y) with size `s` */
export function SpaceIcon({ kind, x, y, s }: { kind: string; x: number; y: number; s: number }): JSX.Element {
  const k = s / 40;
  const g = (children: JSX.Element) => <g transform={`translate(${x} ${y}) scale(${k})`}>{children}</g>;
  switch (kind) {
    case 'station':
      return g(
        <g>
          <rect x={8} y={4} width={24} height={26} rx={6} fill={INK} />
          <rect x={12} y={8} width={16} height={9} rx={2} fill="#9ed3ff" />
          <circle cx={14} cy={23} r={2.4} fill="#ffd34d" />
          <circle cx={26} cy={23} r={2.4} fill="#ffd34d" />
          <path d="M12 30l-4 7M28 30l4 7M10 34h20" stroke={INK} strokeWidth={2.4} strokeLinecap="round" />
        </g>
      );
    case 'power':
      return g(
        <g>
          <circle cx={20} cy={20} r={17} fill="#fff3c4" />
          <path d="M22 4L9 23h9l-3 13 15-20h-9z" fill="#f2b705" stroke="#b07f00" strokeWidth={1.5} strokeLinejoin="round" />
        </g>
      );
    case 'water':
      return g(
        <g>
          <circle cx={20} cy={20} r={17} fill="#dff1ff" />
          <path d="M20 5C14 14 10 19 10 25a10 10 0 0020 0c0-6-4-11-10-20z" fill="#2f8fe0" />
          <path d="M15 25a5 5 0 004 5" stroke="#fff" strokeWidth={2} fill="none" strokeLinecap="round" />
        </g>
      );
    case 'surprise':
      return g(
        <g>
          <circle cx={20} cy={20} r={17} fill="#ff7a1a" />
          <text x={20} y={21} textAnchor="middle" dominantBaseline="central" fontSize={26} fontWeight={900} fill="#fff" fontFamily="'Bricolage Grotesque Variable', 'Figtree Variable', sans-serif">?</text>
        </g>
      );
    case 'treasure':
      return g(
        <g>
          <path d="M6 18a14 10 0 0128 0v4H6z" fill="#b86b2d" />
          <rect x={6} y={18} width={28} height={16} rx={2} fill="#d98a3d" />
          <rect x={6} y={21} width={28} height={3} fill="#f6c453" />
          <rect x={17} y={19} width={6} height={8} rx={1.5} fill="#f6c453" stroke="#8a4b17" strokeWidth={1} />
          <circle cx={20} cy={8} r={2} fill="#ffe680" />
          <circle cx={30} cy={11} r={1.4} fill="#ffe680" />
        </g>
      );
    case 'tax':
      return g(
        <g>
          <path d="M9 4h22v32l-4-3-3.5 3-3.5-3-3.5 3-3.5-3-4 3z" fill="#fff" stroke={INK} strokeWidth={1.8} strokeLinejoin="round" />
          <path d="M14 12h12M14 18h12M14 24h7" stroke={INK} strokeWidth={2} strokeLinecap="round" />
          <circle cx={29} cy={29} r={8} fill="#2fa84f" />
          <text x={29} y={30} textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={800} fill="#fff">₹</text>
        </g>
      );
    case 'chai':
      return g(
        <g>
          <path d="M14 6c-2 3 2 4 0 7M20 4c-2 3 2 4 0 8M26 6c-2 3 2 4 0 7" stroke="#9aa" strokeWidth={1.8} fill="none" strokeLinecap="round" />
          <path d="M8 16h22l-3 18H11z" fill="#fff" stroke={INK} strokeWidth={2} strokeLinejoin="round" />
          <path d="M9 20h20l-1 6H10z" fill="#b86b2d" />
          <path d="M30 19c6 0 6 9 0 9" stroke={INK} strokeWidth={2} fill="none" />
        </g>
      );
    case 'police':
      return g(
        <g>
          <path d="M5 20c0-8 7-14 15-14s15 6 15 14z" fill="#2a4fb5" />
          <rect x={4} y={19} width={32} height={6} rx={3} fill={INK} />
          <path d="M20 9l3 5h-6z" fill="#f2cb05" />
          <circle cx={20} cy={15} r={3} fill="#f2cb05" />
          <path d="M8 27h24l-3 8H11z" fill="#3b3f4a" />
        </g>
      );
    case 'jail':
      return g(
        <g>
          <rect x={4} y={4} width={32} height={32} rx={3} fill="#f6a623" />
          <circle cx={20} cy={18} r={7} fill="#e8c39e" />
          <path d="M11 34c1-6 5-9 9-9s8 3 9 9" fill="#e8c39e" />
          <path d="M10 4v32M17 4v32M23 4v32M30 4v32" stroke={INK} strokeWidth={2.4} />
          <rect x={4} y={4} width={32} height={32} rx={3} fill="none" stroke={INK} strokeWidth={2.4} />
        </g>
      );
    case 'start':
      return g(
        <g>
          <path d="M34 20H8M8 20l9-9M8 20l9 9" stroke="#e0393e" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </g>
      );
    default:
      return <g />;
  }
}

/** A player's token: their colour, with a white vehicle on top (24 × 24 icons) */
const TOKEN_PATHS: Record<TokenId, JSX.Element> = {
  auto: (
    <g fill="#fff">
      <path d="M5 15V9c0-2 2-4 5-4h5c2 0 4 1 5 3l2 5v2z" />
      <rect x={4} y={14} width={18} height={3} rx={1.5} />
      <circle cx={7} cy={18} r={2.4} />
      <circle cx={19} cy={18} r={2.4} />
    </g>
  ),
  car: (
    <g fill="#fff">
      <path d="M3 15l2-5c1-2 2-3 4-3h6c2 0 3 1 4 3l2 5z" />
      <rect x={2} y={14} width={20} height={4} rx={2} />
      <circle cx={7} cy={18.5} r={2.3} />
      <circle cx={17} cy={18.5} r={2.3} />
    </g>
  ),
  scooter: (
    <g fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx={6} cy={17} r={2.6} />
      <circle cx={18} cy={17} r={2.6} />
      <path d="M8 15h7l2-8h3M6 15c0-3 2-4 5-4h3" />
    </g>
  ),
  boat: (
    <g fill="#fff">
      <path d="M3 15h18l-3 4H6z" />
      <path d="M11 4v10H5z" />
      <path d="M12 6l6 8h-6z" opacity={0.85} />
    </g>
  ),
  plane: (
    <g fill="#fff">
      <path d="M21 11c1 0 1 2 0 2h-6l-4 7h-2l2-7H6l-2 2H3l1-3-1-3h1l2 2h5L9 4h2l4 7z" />
    </g>
  ),
  train: (
    <g fill="#fff">
      <rect x={6} y={3} width={12} height={14} rx={3.5} />
      <rect x={8} y={6} width={8} height={4} rx={1} fill="#00000040" />
      <path d="M8 17l-2 3M16 17l2 3" stroke="#fff" strokeWidth={2} strokeLinecap="round" />
    </g>
  )
};

export function Token({ token, color, size = 30, ghost = false }: { token: TokenId; color: string; size?: number; ghost?: boolean }): JSX.Element {
  return (
    <svg className="ty-token-svg" width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" style={{ opacity: ghost ? 0.45 : 1 }}>
      <circle cx={14} cy={15} r={12} fill="#00000055" />
      <circle cx={14} cy={13.5} r={12} fill={color} stroke="#fff" strokeWidth={2} />
      <g transform="translate(2 1.5)">{TOKEN_PATHS[token]}</g>
    </svg>
  );
}

/** Token as part of the board SVG (centred at x, y) */
export function BoardToken({ token, color, x, y, r = 17 }: { token: TokenId; color: string; x: number; y: number; r?: number }): JSX.Element {
  const k = r / 12;
  return (
    <g transform={`translate(${x - 14 * k} ${y - 14 * k}) scale(${k})`}>
      <circle cx={14} cy={16} r={12} fill="#00000050" />
      <circle cx={14} cy={14} r={12} fill={color} stroke="#fff" strokeWidth={2.2} />
      <g transform="translate(2 2)">{TOKEN_PATHS[token]}</g>
    </g>
  );
}

const PIPS: Record<number, [number, number][]> = {
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [2, 0], [0, 2], [2, 2]],
  5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
  6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]]
};

export function Die({ value, x, y, s, rolling }: { value: number; x: number; y: number; s: number; rolling?: boolean }): JSX.Element {
  return (
    <g transform={`translate(${x} ${y})`} className={rolling ? 'ty-die is-rolling' : 'ty-die'}>
      <rect width={s} height={s} rx={s * 0.2} fill="#fff" stroke="#23252d" strokeWidth={2} />
      {(PIPS[value] || []).map(([c, r], i) => (
        <circle key={i} cx={s * (0.25 + c * 0.25)} cy={s * (0.25 + r * 0.25)} r={s * 0.085} fill={value === 1 ? '#e0393e' : '#23252d'} />
      ))}
    </g>
  );
}

/** A green house or a red hotel, its base centred at (x, y) */
export function Building({ hotel, x, y, s }: { hotel: boolean; x: number; y: number; s: number }): JSX.Element {
  const w = hotel ? s * 1.9 : s;
  return (
    <g transform={`translate(${x - w / 2} ${y - s})`}>
      <path d={`M0 ${s * 0.45}L${w / 2} 0L${w} ${s * 0.45}V${s}H0Z`} fill={hotel ? '#e0393e' : '#22a35a'} stroke="#0d3b20" strokeWidth={1} strokeLinejoin="round" />
      {hotel && <rect x={w * 0.42} y={s * 0.55} width={w * 0.16} height={s * 0.45} fill="#7a1418" />}
    </g>
  );
}

/** The city skyline in the middle of the board */
export function Skyline({ x, y, w }: { x: number; y: number; w: number }): JSX.Element {
  const k = w / 400;
  return (
    <g transform={`translate(${x} ${y}) scale(${k})`} aria-hidden="true">
      <circle cx={300} cy={34} r={26} fill="#ffd36b" opacity={0.9} />
      <g fill="#2f6f8f" opacity={0.35}>
        <rect x={0} y={70} width={30} height={60} />
        <rect x={34} y={50} width={24} height={80} />
        <rect x={250} y={60} width={26} height={70} />
        <rect x={350} y={44} width={30} height={86} />
      </g>
      <g fill="#1d4e6a">
        <rect x={20} y={80} width={36} height={50} />
        <rect x={62} y={40} width={30} height={90} />
        <path d="M100 130V60l20-16 20 16v70z" />
        {/* gateway arch */}
        <path d="M150 130V64h70v66h-14V96a21 21 0 00-42 0v34z" />
        <rect x={146} y={56} width={78} height={10} rx={2} />
        <circle cx={185} cy={52} r={6} />
        <rect x={232} y={70} width={26} height={60} />
        {/* minaret */}
        <rect x={266} y={50} width={12} height={80} />
        <circle cx={272} cy={46} r={8} />
        <rect x={290} y={86} width={40} height={44} />
        <rect x={336} y={30} width={22} height={100} />
        <path d="M336 30l11-18 11 18z" />
        <rect x={364} y={74} width={36} height={56} />
      </g>
      <g fill="#ffe7a3" opacity={0.9}>
        {Array.from({ length: 18 }, (_, i) => (
          <rect key={i} x={[26, 40, 68, 80, 68, 80, 238, 246, 296, 310, 296, 310, 340, 350, 340, 370, 384, 370][i]} y={[90, 104, 52, 52, 72, 92, 80, 98, 96, 96, 112, 112, 50, 70, 90, 86, 86, 104][i]} width={6} height={7} />
        ))}
      </g>
      <rect x={-10} y={128} width={420} height={6} rx={3} fill="#1d4e6a" />
    </g>
  );
}
