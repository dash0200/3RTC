/**
 * Last Card's cards as vector art (60 × 90 box): a white rim, a coloured panel and a big white
 * symbol, with small ones in two corners. Wilds have a four-colour wheel. The back is our own
 * design.
 */
import type { JSX } from 'react';
import { card, type CardColor } from './rules';

export const CARD_COLORS: Record<CardColor | 'w', string> = {
  r: '#e5484d',
  y: '#f2b705',
  g: '#2fa84f',
  b: '#2f7fe0',
  w: '#1d1f27'
};
const DARKER: Record<CardColor | 'w', string> = { r: '#b93338', y: '#c99300', g: '#21823b', b: '#215fb0', w: '#101116' };

function Wheel({ cx, cy, r }: { cx: number; cy: number; r: number }): JSX.Element {
  const q = (a0: number, a1: number, fill: string): JSX.Element => {
    const p = (a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
    return <path d={`M${cx} ${cy}L${p(a0)}A${r} ${r} 0 0 1 ${p(a1)}Z`} fill={fill} />;
  };
  const t = Math.PI / 2;
  return (
    <g>
      {q(-t * 2, -t, CARD_COLORS.r)}
      {q(-t, 0, CARD_COLORS.b)}
      {q(0, t, CARD_COLORS.y)}
      {q(t, t * 2, CARD_COLORS.g)}
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#fff" strokeWidth={r * 0.12} />
    </g>
  );
}

/** The symbol of a card, centred at (cx, cy), `s` = size */
function Symbol({ value, cx, cy, s, ink }: { value: string; cx: number; cy: number; s: number; ink: string }): JSX.Element {
  const text = (t: string, size = s) => (
    <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={size} fontWeight={800} fill={ink} fontFamily="'Figtree Variable', system-ui, sans-serif">
      {t}
    </text>
  );
  switch (value) {
    case 'S':
      return (
        <g fill="none" stroke={ink} strokeWidth={s * 0.14} strokeLinecap="round">
          <circle cx={cx} cy={cy} r={s * 0.36} />
          <path d={`M${cx - s * 0.25} ${cy + s * 0.25}L${cx + s * 0.25} ${cy - s * 0.25}`} />
        </g>
      );
    case 'R': {
      const r = s * 0.32;
      const w = s * 0.13;
      return (
        <g fill="none" stroke={ink} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">
          <path d={`M${cx - r} ${cy - w}A${r} ${r} 0 0 1 ${cx + r * 0.75} ${cy - r * 0.75}`} />
          <path d={`M${cx + r * 0.35} ${cy - r * 1.05}L${cx + r * 0.8} ${cy - r * 0.72}L${cx + r * 0.45} ${cy - r * 0.3}`} />
          <path d={`M${cx + r} ${cy + w}A${r} ${r} 0 0 1 ${cx - r * 0.75} ${cy + r * 0.75}`} />
          <path d={`M${cx - r * 0.35} ${cy + r * 1.05}L${cx - r * 0.8} ${cy + r * 0.72}L${cx - r * 0.45} ${cy + r * 0.3}`} />
        </g>
      );
    }
    case 'D':
      return text('+2', s * 0.8);
    case 'W':
      return <Wheel cx={cx} cy={cy} r={s * 0.42} />;
    case 'F':
      return (
        <g>
          <Wheel cx={cx} cy={cy} r={s * 0.42} />
          <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={s * 0.42} fontWeight={900} fill="#fff" stroke="#111" strokeWidth={s * 0.05} paintOrder="stroke" fontFamily="'Figtree Variable', system-ui, sans-serif">
            +4
          </text>
        </g>
      );
    default:
      return text(value);
  }
}

const cornerLabel = (value: string): string => (value === 'S' ? '⊘' : value === 'R' ? '⇄' : value === 'D' ? '+2' : value === 'F' ? '+4' : value === 'W' ? 'W' : value);

export function CardFace({ id, className }: { id: number; className?: string }): JSX.Element {
  const c = card(id);
  const fill = CARD_COLORS[c.color];
  const corner = cornerLabel(c.value);
  return (
    <svg className={className} viewBox="0 0 60 90" role="img" aria-hidden="true">
      <rect x={0.5} y={0.5} width={59} height={89} rx={7} fill="#fff" stroke="rgba(0,0,0,0.25)" />
      <rect x={4} y={4} width={52} height={82} rx={5} fill={fill} />
      <rect x={9} y={17} width={42} height={56} rx={9} fill={DARKER[c.color]} opacity={0.35} />
      <Symbol value={c.value} cx={30} cy={45} s={30} ink="#fff" />
      <text x={9} y={13} fontSize={10} fontWeight={800} fill="#fff" fontFamily="'Figtree Variable', system-ui, sans-serif">{corner}</text>
      <text x={51} y={74} fontSize={10} fontWeight={800} fill="#fff" dominantBaseline="hanging" transform="rotate(180 51 80)" fontFamily="'Figtree Variable', system-ui, sans-serif">{corner}</text>
    </svg>
  );
}

export function CardBack({ className }: { className?: string }): JSX.Element {
  return (
    <svg className={className} viewBox="0 0 60 90" role="img" aria-hidden="true">
      <defs>
        <pattern id="lc-back-stripes" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
          <rect width="6" height="6" fill="#20222c" />
          <rect width="3" height="6" fill="#262935" />
        </pattern>
      </defs>
      <rect x={0.5} y={0.5} width={59} height={89} rx={7} fill="#fff" stroke="rgba(0,0,0,0.25)" />
      <rect x={4} y={4} width={52} height={82} rx={5} fill="url(#lc-back-stripes)" />
      <g transform="translate(30 45)">
        <rect x={-15} y={-15} width={30} height={30} rx={7} transform="rotate(45)" fill="#e5143d" stroke="#fff" strokeWidth={2} />
        <text y={1} textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={900} fill="#fff" fontFamily="'Figtree Variable', system-ui, sans-serif">LC</text>
      </g>
    </svg>
  );
}
