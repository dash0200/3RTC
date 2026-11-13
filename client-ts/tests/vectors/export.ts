/** Writes the golden vectors: `npx tsx tests/vectors/export.ts [game ...]` (see vectors.ts). */
import { write, type Player } from './vectors.ts';
import { activity } from './players/activity.ts';
import { sample } from './players/sample.ts';
import { chess } from './players/chess.ts';
import { ludo } from './players/ludo.ts';
import { lastcard } from './players/lastcard.ts';
import { tycoon } from './players/tycoon.ts';
import { whiteboardChunk, whiteboardIndex } from './players/whiteboard.ts';

const PLAYERS: Player<any, any>[] = [activity, sample, chess, ludo, lastcard, tycoon, whiteboardIndex, whiteboardChunk];

const wanted = process.argv.slice(2);
for (const p of PLAYERS) {
  if (!wanted.length || wanted.includes(p.game)) write(p);
}
