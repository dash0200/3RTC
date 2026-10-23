import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The site's Content-Security-Policy (vercel.json) must allow every outside script the app loads
// itself. Missing hosts break silently in production only: the dev server sends no CSP, and the
// browser tests stub the players. (Vimeo and Twitch were blocked this way.)
const ROOT = join(import.meta.dirname, '..', '..');
const CONFIGS = [join(ROOT, 'vercel.json'), join(ROOT, '..', 'vercel.json')];
const ADAPTERS = join(ROOT, 'src', 'features', 'media', 'adapters');

function scriptSrc(configPath: string): string[] {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    headers?: { headers: { key: string; value: string }[] }[];
  };
  const csp = (config.headers || [])
    .flatMap((h) => h.headers)
    .find((h) => h.key === 'Content-Security-Policy')?.value;
  assert.ok(csp, `${configPath} has a Content-Security-Policy`);
  const directive = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src '));
  assert.ok(directive, `${configPath} has a script-src`);
  return directive.split(/\s+/).slice(1);
}

function loadedScriptOrigins(): string[] {
  const origins = new Set<string>();
  for (const file of readdirSync(ADAPTERS)) {
    const source = readFileSync(join(ADAPTERS, file), 'utf8');
    for (const m of source.matchAll(/loadScript(?:<[^>]*>)?\(\s*['"](https:\/\/[^'"]+)['"]/g)) {
      origins.add(new URL(m[1]).origin);
    }
  }
  return [...origins];
}

describe('Content-Security-Policy', () => {
  const origins = loadedScriptOrigins();

  it('finds the player scripts the adapters load', () => {
    assert.ok(origins.includes('https://player.vimeo.com'), origins.join(', '));
    assert.ok(origins.includes('https://player.twitch.tv'), origins.join(', '));
  });

  for (const config of CONFIGS) {
    it(`${config.includes('client-ts') ? 'client-ts' : 'root'} vercel.json allows every player script`, () => {
      const allowed = scriptSrc(config);
      for (const origin of origins) {
        assert.ok(allowed.includes(origin), `script-src is missing ${origin}`);
      }
    });
  }
});
