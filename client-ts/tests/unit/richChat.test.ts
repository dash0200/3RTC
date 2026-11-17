import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMentions, cleanReplyRef } from '../../src/features/chat/chatFields.ts';
import { cleanPreview, firstLink, previewEndpoint } from '../../src/features/chat/linkPreviewClient.ts';

describe('rich chat fields from peers', () => {
  it('keeps a well-formed reply, cut to size and flattened to plain text', () => {
    assert.deepEqual(cleanReplyRef({ id: 'm1', sender: 'Sai', text: '**hi** there' }), { id: 'm1', sender: 'Sai', text: 'hi there' });
    const long = cleanReplyRef({ id: 'm2', sender: 'x'.repeat(100), text: 'y'.repeat(500) })!;
    assert.equal(long.sender.length, 40);
    assert.ok(long.text.length <= 140);
  });

  it('drops a malformed reply', () => {
    for (const bad of [null, 'm1', { id: '' }, { id: 7 }, { id: 'z'.repeat(65) }, []]) {
      assert.equal(cleanReplyRef(bad), undefined, JSON.stringify(bad));
    }
    assert.deepEqual(cleanReplyRef({ id: 'm3', sender: 5, text: {} }), { id: 'm3', sender: '', text: '' });
  });

  it('keeps at most 10 short string mentions', () => {
    assert.deepEqual(cleanMentions(['a', 'b']), ['a', 'b']);
    assert.deepEqual(cleanMentions(['a', 3, '', null, 'x'.repeat(65), 'b']), ['a', 'b']);
    assert.equal(cleanMentions(Array.from({ length: 50 }, (_, i) => `p${i}`)).length, 10);
    assert.deepEqual(cleanMentions('everyone'), []);
  });
});

describe('link previews (web)', () => {
  it('asks the signaling server over https (http for a local one)', () => {
    assert.equal(
      previewEndpoint('wss://orc.3rtc.me', 'https://x.com/a?b=1'),
      'https://orc.3rtc.me/api/link-preview?url=https%3A%2F%2Fx.com%2Fa%3Fb%3D1'
    );
    assert.equal(previewEndpoint('ws://localhost:8080', 'https://x.com'), 'http://localhost:8080/api/link-preview?url=https%3A%2F%2Fx.com');
    assert.equal(previewEndpoint('not a url', 'https://x.com'), null);
  });

  it('finds the first link in a message', () => {
    assert.equal(firstLink('see www.a.com and https://b.com'), 'https://www.a.com');
    assert.equal(firstLink('no links'), null);
  });

  it('keeps a preview only with a title, and its picture only over https', () => {
    assert.equal(cleanPreview({ title: '' }), null);
    assert.equal(cleanPreview('x'), null);
    const p = cleanPreview({ url: 'https://a.com', title: 'T', description: 'D', image: 'http://a.com/i.png', siteName: 'A' })!;
    assert.equal(p.image, '');
    assert.equal(cleanPreview({ title: 'T', image: 'https://a.com/i.png' })!.image, 'https://a.com/i.png');
    assert.equal(cleanPreview({ title: 'T', image: 'javascript:alert(1)' })!.image, '');
  });
});
