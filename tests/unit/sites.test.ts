import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NEVER_INJECT, neverInject, sitePattern } from '../../packages/extension/src/sites';

// The page agent patches WebAssembly in the MAIN world, and a captcha frame that sees it fails.
describe('which pages the agent may enter', () => {
  it('the manifest injects nothing by itself', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../packages/extension/src/manifest.json', import.meta.url), 'utf8'));
    expect(manifest.content_scripts).toBeUndefined();
  });

  it('never enters captcha and sign-in hosts', () => {
    for (const url of [
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc',
      'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html',
      'https://hcaptcha.com/1/api.js',
      'https://www.google.com/recaptcha/api2/anchor?k=x',
      'https://www.recaptcha.net/recaptcha/api2/bframe',
      'https://accounts.google.com/signin',
      'https://dash.cloudflare.com/login',
    ]) {
      expect(neverInject(url), url).toBe(true);
      expect(sitePattern(url), url).toBeUndefined();
    }
    expect(NEVER_INJECT).toContain('*://challenges.cloudflare.com/*');
  });

  it('a site is its scheme and host, any port, and only http(s)', () => {
    expect(sitePattern('http://127.0.0.1:4174/index.html')).toBe('http://127.0.0.1/*');
    expect(sitePattern('https://www.youtube.com/playables/abc')).toBe('https://www.youtube.com/*');
    expect(sitePattern('https://www.google.com/search?q=wasm')).toBe('https://www.google.com/*');
    expect(sitePattern('https://evilhcaptcha.com/')).toBe('https://evilhcaptcha.com/*');
    expect(sitePattern('chrome://extensions')).toBeUndefined();
    expect(sitePattern('about:blank')).toBeUndefined();
    expect(sitePattern(undefined)).toBeUndefined();
  });
});
