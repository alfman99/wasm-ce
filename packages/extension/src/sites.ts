/**
 * Which pages the page agent may enter. It patches `WebAssembly` in the MAIN world at
 * `document_start`, and captcha and sign-in frames check that natives like that are untouched, so it
 * runs only on sites the human turned on, and never in these hosts, even inside a site that is on.
 */
const NEVER: Array<[host: string, path: string]> = [
  ['challenges.cloudflare.com', '/'],
  ['*.hcaptcha.com', '/'],
  ['www.google.com', '/recaptcha/'],
  ['www.recaptcha.net', '/'],
  ['accounts.google.com', '/'],
  ['dash.cloudflare.com', '/'],
];

/** The same list as match patterns, for `excludeMatches`. `*://` is http and https. */
export const NEVER_INJECT: string[] = NEVER.map(([host, path]) => `*://${host}${path}*`);

export function neverInject(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return NEVER.some(
    ([host, path]) =>
      (host.startsWith('*.')
        ? parsed.hostname === host.slice(2) || parsed.hostname.endsWith(host.slice(1))
        : parsed.hostname === host) && parsed.pathname.startsWith(path),
  );
}

/**
 * `https://example.com/*` for an http(s) page the agent may enter, `undefined` otherwise. Any port:
 * a site is its host, and a dev server that moves port is still the same site.
 */
export function sitePattern(url: string | undefined): string | undefined {
  if (!url || neverInject(url)) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? `${parsed.protocol}//${parsed.hostname}/*` : undefined;
  } catch {
    return undefined;
  }
}
