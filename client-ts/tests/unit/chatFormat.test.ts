import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatChat,
  mentionedPeerIds,
  mentionQueryAt,
  plainSnippet,
  type ChatNode
} from '../../src/utils/chatFormat.ts';

const people = [
  { peerId: 'p-sai', name: 'Sai' },
  { peerId: 'p-saik', name: 'Sai Kumar' },
  { peerId: 'p-me', name: 'Darshan', self: true }
];

// A compact form of the tree for assertions: "b(x)", "@Sai", "<code>", "[link]"
function show(nodes: ChatNode[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text': return n.v;
        case 'code': return `<${n.v}>`;
        case 'link': return `[${n.href}]`;
        case 'mention': return `{${n.peerId}${n.self ? '!' : ''}}`;
        default: return `${n.t}(${show(n.c)})`;
      }
    })
    .join('');
}

describe('chat formatting', () => {
  it('plain text stays plain', () => {
    assert.equal(show(formatChat('hello there')), 'hello there');
    assert.equal(show(formatChat('')), '');
  });

  it('bold, italic and struck text', () => {
    assert.equal(show(formatChat('a **big** deal')), 'a b(big) deal');
    assert.equal(show(formatChat('*soft* and _also_')), 'i(soft) and i(also)');
    assert.equal(show(formatChat('~~old~~ new')), 's(old) new');
    assert.equal(show(formatChat('**bold _and italic_**')), 'b(bold i(and italic))');
  });

  it('leaves maths, snake_case and lone markers alone', () => {
    assert.equal(show(formatChat('2 * 3 * 4')), '2 * 3 * 4');
    assert.equal(show(formatChat('my_var_name')), 'my_var_name');
    assert.equal(show(formatChat('** nope **')), '** nope **');
    assert.equal(show(formatChat('a*')), 'a*');
  });

  it("code isn't formatted inside", () => {
    assert.equal(show(formatChat('run `npm **test**` now')), 'run <npm **test**> now');
  });

  it('links keep working, and markers in links are not emphasis', () => {
    assert.equal(show(formatChat('see https://x.com/a_b_c ok')), 'see [https://x.com/a_b_c] ok');
    assert.equal(show(formatChat('**www.foo.org**')), '**[https://www.foo.org]**');
  });

  it('mentions: longest name first, any case, not inside emails', () => {
    assert.equal(show(formatChat('hey @Sai Kumar and @sai!', people)), 'hey {p-saik} and {p-sai}!');
    assert.equal(show(formatChat('mail sai@Sai.com', people)), 'mail sai@Sai.com');
    assert.equal(show(formatChat('@Darshan look', people)), '{p-me!} look');
    assert.equal(show(formatChat('**@Sai** hi', people)), 'b({p-sai}) hi');
    assert.equal(show(formatChat('@Saiyan', people)), '@Saiyan', 'a longer word is not a mention');
  });

  it('names with regex characters are matched literally', () => {
    const odd = [{ peerId: 'x', name: 'A.B (C)' }];
    assert.equal(show(formatChat('@A.B (C) hi', odd)), '{x} hi');
    assert.equal(show(formatChat('@AxB (C) hi', odd)), '@AxB (C) hi');
  });

  it('collects who a message mentions, once each', () => {
    assert.deepEqual(mentionedPeerIds('@Sai @sai and @Sai Kumar', people).sort(), ['p-sai', 'p-saik']);
    assert.deepEqual(mentionedPeerIds('no one', people), []);
  });

  it('a reply snippet is plain, one line and short', () => {
    assert.equal(plainSnippet('**hi**\n  _there_ `x`'), 'hi there x');
    assert.equal(plainSnippet('a'.repeat(200), 10), `${'a'.repeat(9)}…`);
  });

  it('finds the @name being typed', () => {
    assert.deepEqual(mentionQueryAt('hi @Sa', 6), { query: 'Sa', start: 3 });
    assert.deepEqual(mentionQueryAt('@', 1), { query: '', start: 0 });
    assert.equal(mentionQueryAt('mail me@x', 9), null);
    assert.equal(mentionQueryAt('hi Sa', 5), null);
  });

  it("can't nest forever", () => {
    const deep = '**'.repeat(30) + 'x' + '**'.repeat(30);
    assert.doesNotThrow(() => formatChat(deep));
  });
});
