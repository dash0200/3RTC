/**
 * The Tycoon board as one SVG (1000 × 1000): spaces around the edge, the skyline, card piles and
 * dice in the middle, tokens walking from space to space, houses, owners and mortgages.
 */
import { memo, type JSX } from 'react';
import { GROUP_COLORS, SPACES, type Space } from './board';
import { BoardToken, Building, Die, SpaceIcon, Skyline } from './art';
import { rupees, type TyState } from './rules';

export const SIZE = 1000;
const C = 130; // corner
const W = (SIZE - 2 * C) / 9; // edge space width

/** Where a point given in a space's own frame (as if on the bottom row) lands on the board */
export function spaceTransform(i: number): string {
  if (i % 10 === 0) return '';
  const k = i % 10;
  if (i < 10) return `translate(${SIZE - C - k * W} ${SIZE - C})`;
  if (i < 20) return `translate(${C} ${SIZE - C - k * W}) rotate(90)`;
  if (i < 30) return `translate(${C + k * W} ${C}) rotate(180)`;
  return `translate(${SIZE - C} ${C + k * W}) rotate(270)`;
}

export function spacePoint(i: number, lx: number, ly: number): { x: number; y: number } {
  if (i % 10 === 0) {
    const corner = [
      { x: SIZE - C, y: SIZE - C },
      { x: 0, y: SIZE - C },
      { x: 0, y: 0 },
      { x: SIZE - C, y: 0 }
    ][i / 10];
    return { x: corner.x + C / 2, y: corner.y + C / 2 };
  }
  const k = i % 10;
  if (i < 10) return { x: SIZE - C - k * W + lx, y: SIZE - C + ly };
  if (i < 20) return { x: C - ly, y: SIZE - C - k * W + lx };
  if (i < 30) return { x: C + k * W - lx, y: C - ly };
  return { x: SIZE - C + ly, y: C + k * W - lx };
}

/** Split a name into at most two lines */
function lines(name: string, max = 12): string[] {
  if (name.length <= max) return [name];
  const words = name.split(' ');
  let a = '';
  let i = 0;
  while (i < words.length && (a + (a ? ' ' : '') + words[i]).length <= max) a += (a ? ' ' : '') + words[i++];
  if (!a) return [name.slice(0, max), name.slice(max)];
  return [a, words.slice(i).join(' ')];
}

const T = ({ x, y, size, weight = 700, fill = '#23252d', children }: { x: number; y: number; size: number; weight?: number; fill?: string; children: string }) => (
  <text x={x} y={y} textAnchor="middle" fontSize={size} fontWeight={weight} fill={fill} fontFamily="'Figtree Variable', system-ui, sans-serif">
    {children}
  </text>
);

function EdgeSpace({ sp, i }: { sp: Space; i: number }): JSX.Element {
  const name = lines(sp.name);
  const nameY = sp.kind === 'property' ? 42 : 20;
  return (
    <>
      <rect width={W} height={C} fill="#fbf6e9" stroke="#2b2d35" strokeWidth={1.5} />
      {sp.kind === 'property' && <rect width={W} height={24} fill={GROUP_COLORS[sp.group]} stroke="#2b2d35" strokeWidth={1.5} />}
      {name.map((l, n) => (
        <T key={n} x={W / 2} y={nameY + n * 13} size={11.5}>{l}</T>
      ))}
      {sp.kind === 'property' && <T x={W / 2} y={nameY + name.length * 13 + 2} size={9.5} weight={500} fill="#6b6e78">{sp.city}</T>}
      {sp.kind === 'station' && <SpaceIcon kind="station" x={W / 2 - 20} y={52} s={40} />}
      {sp.kind === 'utility' && <SpaceIcon kind={sp.icon} x={W / 2 - 20} y={52} s={40} />}
      {sp.kind === 'surprise' && <SpaceIcon kind="surprise" x={W / 2 - 22} y={44} s={44} />}
      {sp.kind === 'treasure' && <SpaceIcon kind="treasure" x={W / 2 - 22} y={44} s={44} />}
      {sp.kind === 'tax' && <SpaceIcon kind="tax" x={W / 2 - 19} y={46} s={38} />}
      {'price' in sp && <T x={W / 2} y={C - 10} size={11.5} weight={600}>{rupees(sp.price)}</T>}
      {sp.kind === 'tax' && <T x={W / 2} y={C - 10} size={11.5} weight={600}>{`Pay ${rupees(sp.amount)}`}</T>}
      <title>{`${i}`}</title>
    </>
  );
}

const Corner = ({ i }: { i: number }): JSX.Element => {
  const at = [
    { x: SIZE - C, y: SIZE - C },
    { x: 0, y: SIZE - C },
    { x: 0, y: 0 },
    { x: SIZE - C, y: 0 }
  ][i / 10];
  const sp = SPACES[i];
  return (
    <g transform={`translate(${at.x} ${at.y})`}>
      <rect width={C} height={C} fill="#fbf6e9" stroke="#2b2d35" strokeWidth={1.5} />
      {sp.kind === 'start' && (
        <>
          <T x={C / 2} y={42} size={15} weight={600}>COLLECT ₹2,000</T>
          <T x={C / 2} y={78} size={30} weight={900} fill="#e0393e">START</T>
          <SpaceIcon kind="start" x={C / 2 - 26} y={86} s={52} />
        </>
      )}
      {sp.kind === 'jail' && (
        <>
          <rect x={C - 84} width={84} height={84} fill="#ffe2a8" stroke="#2b2d35" strokeWidth={1.5} />
          <SpaceIcon kind="jail" x={C - 70} y={14} s={56} />
          <T x={C - 42} y={80} size={12} weight={800}>IN JAIL</T>
          <text x={22} y={C / 2} fontSize={12} fontWeight={700} fill="#23252d" transform={`rotate(90 22 ${C / 2})`} textAnchor="middle" fontFamily="'Figtree Variable', sans-serif">JUST</text>
          <T x={C / 2 - 10} y={C - 14} size={12}>VISITING</T>
        </>
      )}
      {sp.kind === 'parking' && (
        <>
          <SpaceIcon kind="chai" x={C / 2 - 30} y={20} s={60} />
          <T x={C / 2} y={98} size={17} weight={900} fill="#b86b2d">CHAI</T>
          <T x={C / 2} y={117} size={17} weight={900} fill="#b86b2d">BREAK</T>
        </>
      )}
      {sp.kind === 'gotojail' && (
        <>
          <SpaceIcon kind="police" x={C / 2 - 30} y={18} s={60} />
          <T x={C / 2} y={98} size={15} weight={900} fill="#2a4fb5">GO TO</T>
          <T x={C / 2} y={117} size={15} weight={900} fill="#2a4fb5">JAIL</T>
        </>
      )}
    </g>
  );
};

/** The spaces never change: drawn once */
const StaticBoard = memo(function StaticBoard(): JSX.Element {
  return (
    <g>
      <rect width={SIZE} height={SIZE} fill="#fbf6e9" />
      <defs>
        <linearGradient id="ty-center" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d6f1e6" />
          <stop offset="100%" stopColor="#bfe3d6" />
        </linearGradient>
        <pattern id="ty-mortgage" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="10" height="10" fill="#ffffff00" />
          <rect width="4" height="10" fill="#23252d33" />
        </pattern>
      </defs>
      <rect x={C} y={C} width={SIZE - 2 * C} height={SIZE - 2 * C} fill="url(#ty-center)" stroke="#2b2d35" strokeWidth={1.5} />
      <Skyline x={C + 70} y={C + 60} w={SIZE - 2 * C - 140} />
      <g transform={`translate(${SIZE / 2} ${C + 268})`}>
        <text textAnchor="middle" fontSize={92} fontWeight={900} fill="#e0393e" stroke="#23252d" strokeWidth={4} paintOrder="stroke" fontFamily="'Bricolage Grotesque Variable', 'Figtree Variable', sans-serif" letterSpacing={4}>TYCOON</text>
        <text y={36} textAnchor="middle" fontSize={19} fontWeight={700} fill="#1d4e6a" fontFamily="'Figtree Variable', sans-serif" letterSpacing={6}>BUY · BUILD · BARGAIN</text>
      </g>
      {/* card piles */}
      <g transform={`translate(${C + 92} ${SIZE - C - 210}) rotate(-12)`}>
        <rect width={150} height={92} rx={10} fill="#ff7a1a" stroke="#23252d" strokeWidth={2.5} />
        <rect x={6} y={6} width={138} height={80} rx={7} fill="none" stroke="#fff" strokeWidth={2} strokeDasharray="6 5" />
        <SpaceIcon kind="surprise" x={18} y={26} s={40} />
        <T x={100} y={53} size={18} weight={900} fill="#fff">SURPRISE</T>
      </g>
      <g transform={`translate(${SIZE - C - 245} ${SIZE - C - 240}) rotate(12)`}>
        <rect width={150} height={92} rx={10} fill="#3aa0a5" stroke="#23252d" strokeWidth={2.5} />
        <rect x={6} y={6} width={138} height={80} rx={7} fill="none" stroke="#fff" strokeWidth={2} strokeDasharray="6 5" />
        <SpaceIcon kind="treasure" x={14} y={24} s={42} />
        <T x={100} y={53} size={18} weight={900} fill="#fff">TREASURE</T>
      </g>
      {SPACES.map((sp, i) => (i % 10 === 0 ? <Corner key={i} i={i} /> : <g key={i} transform={spaceTransform(i)}><EdgeSpace sp={sp} i={i} /></g>))}
    </g>
  );
});

export interface BoardViewProps {
  s: TyState;
  /** where each token is drawn right now (animated) */
  shownPos: number[];
  rolling: boolean;
  highlight: number | null;
  onSpace: (i: number) => void;
}

export function BoardView({ s, shownPos, rolling, highlight, onSpace }: BoardViewProps): JSX.Element {
  const dice = s.dice || [5, 3];
  // tokens on the same space sit side by side
  const bySpace = new Map<number, number[]>();
  s.players.forEach((p, seat) => {
    if (p.bankrupt) return;
    const pos = shownPos[seat] ?? p.pos;
    bySpace.set(pos, [...(bySpace.get(pos) || []), seat]);
  });
  return (
    <svg className="ty-board" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="Tycoon board">
      <StaticBoard />
      {/* owners, mortgages, buildings, clickable spaces */}
      {SPACES.map((_, i) => {
        if (i % 10 === 0) return null;
        const owner = s.owner[i];
        const h = s.houses[i];
        return (
          <g key={`o${i}`} transform={spaceTransform(i)} className="ty-space" onClick={() => onSpace(i)}>
            <rect width={W} height={C} fill={highlight === i ? '#ffd34d55' : 'transparent'} />
            {owner !== null && <rect x={3} y={C - 7} width={W - 6} height={6} rx={3} fill={s.players[owner]?.color} />}
            {s.mortgaged[i] && (
              <>
                <rect width={W} height={C} fill="url(#ty-mortgage)" />
                <T x={W / 2} y={C / 2 + 8} size={24} weight={900} fill="#23252dcc">M</T>
              </>
            )}
            {h === 5 && <Building hotel x={W / 2} y={21} s={16} />}
            {h > 0 && h < 5 && Array.from({ length: h }, (_, k) => <Building key={k} hotel={false} x={W / 2 + (k - (h - 1) / 2) * 17} y={21} s={14} />)}
          </g>
        );
      })}
      {[0, 10, 20, 30].map((i) => {
        const p = spacePoint(i, 0, 0);
        return <rect key={`c${i}`} className="ty-space" x={p.x - C / 2} y={p.y - C / 2} width={C} height={C} fill={highlight === i ? '#ffd34d55' : 'transparent'} onClick={() => onSpace(i)} />;
      })}

      {/* dice and the pot */}
      <g transform={`translate(${SIZE / 2 - 70} ${SIZE / 2 + 105})`}>
        <Die value={dice[0]} x={0} y={0} s={62} rolling={rolling} />
        <Die value={dice[1]} x={78} y={0} s={62} rolling={rolling} />
      </g>
      {s.rules.jackpot && (
        <g transform={`translate(${C + 40} ${C + 40})`}>
          <rect width={170} height={44} rx={22} fill="#fff8e1" stroke="#b86b2d" strokeWidth={2} />
          <T x={85} y={29} size={18} weight={800} fill="#b86b2d">{`☕ Pot ${rupees(s.pot)}`}</T>
        </g>
      )}

      {/* tokens */}
      {[...bySpace.entries()].flatMap(([pos, seats]) =>
        seats.map((seat, k) => {
          const p = s.players[seat];
          const n = seats.length;
          const spread = n > 1 ? (k - (n - 1) / 2) * 22 : 0;
          const inJailCell = pos === 10 && p.jail > 0;
          const base = pos % 10 === 0 ? spacePoint(pos, 0, 0) : spacePoint(pos, W / 2 + spread * 0.6, C * 0.66 + (n > 2 ? (k % 2) * 10 : 0));
          const at = pos % 10 === 0 ? { x: base.x + spread + (inJailCell ? 22 : pos === 10 ? -34 : 0), y: base.y + (inJailCell ? -20 : pos === 10 ? 34 : 18) } : base;
          return (
            <g key={p.id} className={`ty-token${seat === s.turn ? ' is-turn' : ''}`} style={{ transform: `translate(${at.x}px, ${at.y}px)` }}>
              <BoardToken token={p.token} color={p.color} x={0} y={0} r={seat === s.turn ? 19 : 16} />
            </g>
          );
        })
      )}
    </svg>
  );
}
