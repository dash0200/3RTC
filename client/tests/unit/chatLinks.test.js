import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLinks } from '../../src/utils/chatLinks.js';

const links = (t) => splitLinks(t).filter((p) => p.href).map((p) => [p.text, p.href]);

test('web addresses become links; the text around them stays', () => {
    assert.deepEqual(splitLinks('see https://example.com/a?b=1 now'), [
        { text: 'see ' }, { text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' }, { text: ' now' }
    ]);
    assert.deepEqual(links('www.youtube.com/watch?v=abc'), [['www.youtube.com/watch?v=abc', 'https://www.youtube.com/watch?v=abc']]);
    assert.deepEqual(links('two: http://a.io and https://b.io/x'), [['http://a.io', 'http://a.io'], ['https://b.io/x', 'https://b.io/x']]);
});

test('sentence punctuation is not part of the link; balanced brackets are', () => {
    assert.deepEqual(links('look at https://x.com/page.'), [['https://x.com/page', 'https://x.com/page']]);
    assert.deepEqual(links('(https://x.com/a)'), [['https://x.com/a', 'https://x.com/a']]);
    assert.deepEqual(links('https://en.wikipedia.org/wiki/Foo_(bar)!'), [['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://en.wikipedia.org/wiki/Foo_(bar)']]);
});

test('nothing else is ever a link', () => {
    assert.deepEqual(links('javascript:alert(1) data:text/html,x ftp://a.b example.com hello'), []);
    assert.deepEqual(splitLinks('just text'), [{ text: 'just text' }]);
});
