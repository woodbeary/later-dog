import { TRIAL_ACTION } from "./trial";
import { STYLE, escapeHtml } from "./viewer";

export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

export function trialPageHeaders(nonce: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "strict-origin",
    "x-content-type-options": "nosniff",
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' ${TURNSTILE_ORIGIN}`,
      `style-src 'nonce-${nonce}'`,
      `frame-src ${TURNSTILE_ORIGIN}`,
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  };
}

const PAGE_STYLE = `
  main { position: fixed; inset: 0; display: grid; place-items: center; padding: 16px; text-align: center; }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 6px; }
  p { margin: 0; color: var(--muted); max-width: 36em; }
  form { display: grid; gap: 14px; justify-items: center; margin-top: 18px; }
  .cf-turnstile { min-height: 65px; }
  button[disabled] { opacity: 0.45; cursor: default; }
`;

export function trialPage(options: { claim: string; siteKey: string; minutes: number; days: number; nonce: string }): string {
  const { claim, siteKey, minutes, days, nonce } = options;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Free trial · later.dog</title>
<style nonce="${nonce}">${STYLE}${PAGE_STYLE}</style>
<script nonce="${nonce}">
window.laterdogTrialReady = () => { document.getElementById("start").disabled = false; };
window.laterdogTrialWait = () => { document.getElementById("start").disabled = true; };
</script>
<script nonce="${nonce}" src="${TURNSTILE_ORIGIN}/turnstile/v0/api.js" async defer></script>
</head>
<body><main><div>
<h1>Try a cloud computer free</h1>
<p>${minutes} minutes of use within ${days} days. No card needed. One free trial per network.</p>
<form method="post" action="/trial">
<input type="hidden" name="claim" value="${escapeHtml(claim)}">
<div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-action="${TRIAL_ACTION}" data-cdata="${escapeHtml(claim)}" data-theme="dark" data-callback="laterdogTrialReady" data-expired-callback="laterdogTrialWait" data-error-callback="laterdogTrialWait"></div>
<button type="submit" id="start" disabled>Start free trial</button>
<noscript><p>Turn on JavaScript to finish the check.</p></noscript>
</form>
</div></main></body>
</html>
`;
}
