import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAW_MS,
  DRAWER_POINTS,
  INITIAL,
  PICK_MS,
  REVEAL_MS,
  ROUNDS,
  distance,
  guessPoints,
  hintFor,
  makeReducer,
  normalize,
  pickChoices,
  redact,
  shownLetters,
  addSeen,
  seenForPick,
  seenWords,
  type SketchAction,
  type SketchMeta,
  type SketchState
} from '../../src/features/activities/sketch/rules.ts';
import { WORDS } from '../../src/features/activities/sketch/words.ts';

// A game on a fake clock, with the authority 'a' and everyone present
function game(ids = ['a', 'b', 'c']) {
  let t = 1_000_000;
  let seed = 1;
  const reducer = makeReducer({ now: () => t, rand: () => ((seed = (seed * 16807) % 2147483647) / 2147483647) });
  let s: SketchState = INITIAL;
  let present = [...ids];
  const meta = (by: string): SketchMeta => ({ by, selfId: 'a', present });
  const act = (by: string, a: SketchAction) => (s = reducer(s, a, meta(by)));
  const tick = () => act('a', { kind: 'tick' });
  const advance = (ms: number) => {
    t += ms;
    tick();
  };
  for (const id of ids) act(id, { kind: 'join', name: id.toUpperCase() });
  return {
    get s() { return s; },
    act,
    tick,
    advance,
    setPresent: (p: string[]) => { present = p; },
    score: (id: string) => s.players.find((p) => p.id === id)?.score
  };
}

describe('sketch: words and guesses', () => {
  it('compares guesses loosely', () => {
    assert.equal(normalize('  Ice-Cream!! '), 'ice cream');
    assert.equal(normalize('Café'), 'cafe');
    assert.equal(distance('elephant', 'elephent'), 1);
    assert.equal(distance('cat', 'dog', 1), 2);
  });

  it('hints letters, keeping spaces', () => {
    assert.equal(hintFor('ice cream'), '___ _____');
    assert.equal(hintFor('cat', [1]), '_a_');
    assert.equal(shownLetters('banana', 0.2, 3).length, 0);
    assert.equal(shownLetters('banana', 0.5, 3).length, 1);
    assert.equal(shownLetters('banana', 0.8, 3).length, 2);
    assert.ok(shownLetters('ox', 0.9, 1).length <= 1, 'never the whole word');
  });

  it('picks 3 different words, avoiding played ones', () => {
    const c = pickChoices(Math.random, WORDS.slice(0, WORDS.length - 3));
    assert.equal(new Set(c).size, 3);
    for (const w of c) assert.ok(WORDS.slice(-3).includes(w));
  });

  it('keeps offered words as WORDS indices and starts over when the list is used up', () => {
    const seen = addSeen([], ['cat', 'nope', 'dog', 'cat']);
    assert.deepEqual(seenWords(seen), ['cat', 'dog']);
    assert.deepEqual(seenForPick(seen), seen);
    const almost = WORDS.slice(0, -2).map((_, i) => i);
    assert.deepEqual(seenForPick(almost), [], '2 left: a new round of the list');
    const enough = [...WORDS.slice(0, -3).map((_, i) => i), -1, 99_999, 1.5];
    assert.deepEqual(seenForPick(enough), enough, "3 left (odd entries don't count)");
    assert.deepEqual(seenWords([-1, 99_999, 1.5]), []);
  });

  it('gives 50 to 100 points, more for guessing sooner', () => {
    assert.equal(guessPoints(1), 100);
    assert.equal(guessPoints(0), 50);
    assert.ok(guessPoints(0.8) > guessPoints(0.2));
  });
});

describe('sketch: a game', () => {
  it('needs 2 players to start, and only players start it', () => {
    const g = game(['a']);
    g.act('a', { kind: 'start' });
    assert.equal(g.s.phase, 'lobby');
    g.act('b', { kind: 'start' });
    assert.equal(g.s.phase, 'lobby', 'b is not a player');
  });

  it('plays a turn: pick, guess, points, reveal, next drawer', () => {
    const g = game();
    g.act('b', { kind: 'start' });
    assert.equal(g.s.phase, 'picking');
    const drawer = g.s.drawer!;
    assert.equal(g.s.choices.length, 3);
    g.act('c', { kind: 'pick', index: 0 });
    assert.equal(g.s.phase, 'picking', 'only the drawer picks');
    const word = g.s.choices[1];
    g.act(drawer, { kind: 'pick', index: 1 });
    assert.equal(g.s.phase, 'drawing');
    assert.equal(g.s.word, word);
    assert.equal(g.s.hint, hintFor(word));

    const [first, second] = ['a', 'b', 'c'].filter((id) => id !== drawer);
    g.act(drawer, { kind: 'guess', text: word });
    assert.equal(g.s.guessed.length, 0, 'the drawer cannot guess');
    g.act(first, { kind: 'guess', text: 'nope' });
    assert.equal(g.s.feed.at(-1)!.text, 'nope');
    g.act(first, { kind: 'guess', text: word.toUpperCase() });
    assert.deepEqual(g.s.guessed, [first]);
    assert.equal(g.s.feed.at(-1)!.kind, 'correct');
    assert.ok(!g.s.feed.some((l) => l.text.toLowerCase().includes(word)), 'the right word never shows in the feed');
    assert.equal(g.score(first), 100);
    assert.equal(g.score(drawer), DRAWER_POINTS);
    g.act(first, { kind: 'guess', text: word });
    assert.equal(g.score(first), 100, 'no points twice');

    g.act(second, { kind: 'guess', text: word });
    assert.equal(g.s.phase, 'reveal', 'everyone got it: the turn ends');
    assert.equal(g.s.revealed, word);
    assert.equal(g.s.word, '');
    assert.equal(g.score(drawer), 2 * DRAWER_POINTS);

    g.advance(REVEAL_MS);
    assert.equal(g.s.phase, 'picking');
    assert.notEqual(g.s.drawer, drawer, 'the next person draws');
    assert.ok(!g.s.choices.includes(word), 'a played word is not offered again');
  });

  it('a close guess says so without showing it', () => {
    const g = game();
    g.act('a', { kind: 'start' });
    const drawer = g.s.drawer!;
    g.act(drawer, { kind: 'pick', index: 0 });
    const word = g.s.word;
    const guesser = ['a', 'b', 'c'].find((id) => id !== drawer)!;
    if (word.length >= 4) {
      const typo = word.slice(0, -1) + (word.endsWith('x') ? 'y' : 'x');
      g.act(guesser, { kind: 'guess', text: typo });
      assert.equal(g.s.feed.at(-1)!.kind, 'close');
      assert.ok(!g.s.feed.at(-1)!.text.includes(typo));
    }
  });

  it('time: the first word is picked for a slow drawer, hints appear, time runs out', () => {
    const g = game();
    g.act('a', { kind: 'start' });
    const first = g.s.choices[0];
    g.advance(PICK_MS);
    assert.equal(g.s.phase, 'drawing');
    assert.equal(g.s.word, first);
    g.advance(DRAW_MS * 0.55);
    assert.equal([...g.s.hint].filter((c) => c !== '_' && c !== ' ').length, 1);
    g.advance(DRAW_MS * 0.5);
    assert.equal(g.s.phase, 'reveal');
    assert.equal(g.s.revealed, first);
  });

  it('only the authority moves time on', () => {
    const g = game();
    g.act('a', { kind: 'start' });
    const before = g.s;
    g.act('b', { kind: 'tick' });
    assert.equal(g.s, before);
  });

  it('the word goes only to the drawer until it is revealed', () => {
    const g = game();
    g.act('a', { kind: 'start' });
    const drawer = g.s.drawer!;
    const other = ['a', 'b', 'c'].find((id) => id !== drawer)!;
    assert.equal(redact(g.s, other).choices.length, 0);
    assert.equal(redact(g.s, drawer).choices.length, 3);
    g.act(drawer, { kind: 'pick', index: 0 });
    assert.equal(redact(g.s, other).word, '');
    assert.equal(redact(g.s, drawer).word, g.s.word);
    assert.equal(redact(g.s, other).hint, g.s.hint, 'everyone sees the hint');
  });

  it('a new authority without the word ends the turn instead of hanging', () => {
    const g = game();
    g.act('a', { kind: 'start' });
    g.act(g.s.drawer!, { kind: 'pick', index: 0 });
    const lost = { ...g.s, word: '' };
    const reducer = makeReducer({ now: () => 2_000_000, rand: Math.random });
    const after = reducer(lost, { kind: 'tick' }, { by: 'b', selfId: 'b', present: ['b', 'c', 'a'] });
    assert.equal(after.phase, 'reveal');
  });

  it('the drawer leaving ends the turn; with one person left the game is over', () => {
    const g = game();
    g.act('a', { kind: 'start' });
    const drawer = g.s.drawer!;
    g.setPresent(['a', 'b', 'c'].filter((id) => id !== drawer));
    g.tick();
    assert.equal(g.s.phase, 'reveal');
    g.setPresent(['a']);
    g.advance(REVEAL_MS);
    assert.equal(g.s.phase, 'over');
  });

  it('ends after everyone has drawn ROUNDS times, then can start again', () => {
    const g = game(['a', 'b']);
    g.act('a', { kind: 'start' });
    for (let turn = 0; turn < 2 * ROUNDS; turn++) {
      assert.equal(g.s.phase, 'picking', `turn ${turn}`);
      g.act(g.s.drawer!, { kind: 'skip' });
      g.advance(REVEAL_MS);
    }
    assert.equal(g.s.phase, 'over');
    g.act('b', { kind: 'again' });
    assert.equal(g.s.phase, 'lobby');
    assert.equal(g.s.players.length, 2);
    assert.ok(g.s.players.every((p) => p.score === 0));
  });

  it('never offers a word twice in the room until the list is used up, across games', () => {
    const g = game();
    g.act('a', { kind: 'start' });
    const perCycle = Math.floor(WORDS.length / 3);
    const offered = new Set<string>();
    for (let turn = 0; turn <= perCycle; turn++) {
      assert.equal(g.s.phase, 'picking', `turn ${turn}`);
      if (turn < perCycle) {
        for (const c of g.s.choices) {
          assert.ok(!offered.has(c), `“${c}” came back at turn ${turn}`);
          offered.add(c);
        }
      } else {
        assert.deepEqual(g.s.seen, [], 'the list is used up, so it starts over');
      }
      // passing over all 3 (a skip while picking) counts them as offered
      g.act(g.s.drawer!, { kind: 'skip' });
      g.advance(REVEAL_MS);
      // a fresh read: the assert above narrowed `g.s.phase` to 'picking' for TypeScript
      const after: SketchState = g.s;
      if (after.phase === 'over') {
        g.act('b', { kind: 'again' }); // "Play again" keeps what was offered
        g.act('c', { kind: 'start' });
      }
    }
  });

  it('rejects junk', () => {
    const g = game();
    const before = g.s;
    g.act('a', { kind: 'pick', index: 99 });
    g.act('a', { kind: 'guess', text: 'x' });
    g.act('a', { kind: 'nonsense' } as unknown as SketchAction);
    assert.equal(g.s, before);
    g.act('z', { kind: 'join', name: '  ' + 'n'.repeat(80) });
    assert.equal(g.s.players.at(-1)!.name.length, 24);
  });
});
