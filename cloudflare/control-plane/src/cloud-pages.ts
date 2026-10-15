import { PRIVACY_PAGE, TERMS_PAGE } from "./legal-pages";

const STYLE = `
:root { color-scheme: light dark; --bg: #ffffff; --ink: #0a0a0a; --muted: #6e6e73; --line: #e5e5ea; --field: #f2f2f7; --accent: #0a0a0a; --on-accent: #ffffff; --danger: #d92d20; }
@media (prefers-color-scheme: dark) { :root { --bg: #121212; --ink: #f5f5f5; --muted: #98989f; --line: #2c2c2e; --field: #1c1c1e; --accent: #f5f5f5; --on-accent: #0a0a0a; --danger: #ff6961; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 17px/1.45 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; }
main { width: min(420px, 100% - 32px); padding: 32px 0; }
h1 { font-size: 28px; line-height: 1.15; letter-spacing: -0.02em; margin: 0 0 8px; }
p { margin: 0 0 16px; color: var(--muted); }
.brand { font-weight: 700; letter-spacing: -0.03em; font-size: 20px; margin-bottom: 28px; color: var(--ink); }
.code { font: 600 28px/1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 0.06em; padding: 18px; border-radius: 16px; background: var(--field); text-align: center; margin: 8px 0 20px; color: var(--ink); }
label { display: block; font-size: 13px; color: var(--muted); margin: 0 0 6px; }
input { width: 100%; font: inherit; color: var(--ink); background: var(--field); border: 1px solid transparent; border-radius: 14px; padding: 13px 16px; margin: 0 0 12px; outline: none; }
input:focus { border-color: var(--line); }
button { width: 100%; font: 600 17px/1 inherit; font-family: inherit; border: 0; border-radius: 14px; padding: 15px; cursor: pointer; background: var(--accent); color: var(--on-accent); }
button.quiet { background: transparent; color: var(--muted); font-weight: 500; margin-top: 6px; }
button.danger { background: transparent; color: var(--danger); border: 1px solid var(--line); margin-top: 24px; }
button:disabled { opacity: 0.5; cursor: default; }
.error { color: var(--danger); min-height: 22px; font-size: 15px; margin: 4px 0 0; }
.step[hidden] { display: none; }
.status { padding: 14px 16px; border-radius: 14px; background: var(--field); margin: 0 0 12px; color: var(--ink); }
main.legal { width: min(640px, 100% - 32px); }
.legal h2 { font-size: 19px; margin: 28px 0 8px; }
.legal p, .legal li { color: var(--ink); }
.legal ul { padding-left: 20px; margin: 0 0 16px; }
.legal li { margin: 0 0 8px; }
.legal .status { display: inline-block; padding: 6px 12px; font-size: 14px; color: var(--muted); }
a { color: inherit; }
`;

const SCRIPT = `
const state = { token: sessionStorage.getItem("laterdog.cloud.token") || "", email: "" };
const page = document.body.dataset.page;
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const show = (id) => { for (const step of document.querySelectorAll(".step")) step.hidden = step.id !== id; };
const fail = (message) => { $("error").textContent = message || ""; };
async function call(path, init = {}) {
  const headers = { "content-type": "application/json", ...(state.token ? { authorization: "Bearer " + state.token } : {}) };
  const response = await fetch(path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}
async function sendCode(event) {
  event.preventDefault();
  fail("");
  state.email = $("email").value.trim();
  $("send").disabled = true;
  const { response } = await call("/api/auth/email-otp/send-verification-otp", { method: "POST", body: JSON.stringify({ email: state.email, type: "sign-in" }) });
  $("send").disabled = false;
  if (!response.ok) return fail(response.status === 429 ? "Too many tries. Wait a minute and try again." : "That email didn't work. Check it and try again.");
  $("sent-to").textContent = state.email;
  show("code-step");
  $("otp").focus();
}
async function verify(event) {
  event.preventDefault();
  fail("");
  $("verify").disabled = true;
  const { response } = await call("/api/auth/sign-in/email-otp", { method: "POST", body: JSON.stringify({ email: state.email, otp: $("otp").value.trim(), name: state.email.split("@")[0] }) });
  $("verify").disabled = false;
  const token = response.headers.get("set-auth-token");
  if (!response.ok || !token) return fail("That code didn't work. Check it, or send a new one.");
  state.token = token;
  sessionStorage.setItem("laterdog.cloud.token", token);
  await signedIn();
}
async function decide(decision) {
  fail("");
  const { response } = await call("/api/cloud/desktop/approve", { method: "POST", body: JSON.stringify({ userCode: params.get("code"), decision }) });
  if (!response.ok) return fail("This code has expired. Start again in later.dog.");
  show(decision === "allow" ? "done-step" : "denied-step");
}
async function loadAccount() {
  const { response, body } = await call("/api/cloud/home", { method: "POST", body: "{}" });
  if (response.status === 401) { state.token = ""; sessionStorage.removeItem("laterdog.cloud.token"); return show("email-step"); }
  $("account-email").textContent = body.account ? body.account.email : "";
  const cloud = body.cloud;
  $("home-status").textContent = !cloud ? "later.dog Cloud isn't open to more people yet." : cloud.state === "ready" ? "Your home is ready." : cloud.state === "failed" ? "Your home couldn't be set up yet. We'll keep trying." : "Setting up your home…";
  show("account-step");
  if (cloud && cloud.state === "setting_up") setTimeout(loadAccount, 5000);
}
async function deleteAccount() {
  if (!confirm("Delete your later.dog account? Your home, its dogs and their chats are deleted. This can't be undone.")) return;
  const { response } = await call("/api/cloud/account", { method: "DELETE" });
  if (!response.ok) return fail("Couldn't delete your account. Try again.");
  state.token = ""; sessionStorage.removeItem("laterdog.cloud.token");
  show("deleted-step");
}
async function signedIn() {
  if (page === "desktop") return show("approve-step");
  return loadAccount();
}
async function start() {
  $("email-form").addEventListener("submit", sendCode);
  $("code-form").addEventListener("submit", verify);
  $("restart").addEventListener("click", () => show("email-step"));
  if (page === "desktop") {
    const code = params.get("code") || "";
    $("user-code").textContent = code;
    $("allow").addEventListener("click", () => decide("allow"));
    $("deny").addEventListener("click", () => decide("deny"));
    const { response, body } = await call("/api/cloud/desktop/authorization?code=" + encodeURIComponent(code));
    if (!response.ok) return show("expired-step");
    $("device").textContent = body.deviceName + " · " + ({ darwin: "Mac", win32: "Windows", linux: "Linux" }[body.platform] || body.platform);
  } else {
    $("delete").addEventListener("click", deleteAccount);
    $("sign-out").addEventListener("click", () => { state.token = ""; sessionStorage.removeItem("laterdog.cloud.token"); show("email-step"); });
  }
  if (state.token) return signedIn();
  show("email-step");
}
start();
`;

function htmlPage(title: string, pageName: "desktop" | "account", body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/cloud/style.css">
</head>
<body data-page="${pageName}">
<main>
<div class="brand">later.dog</div>
${body}
<p class="error" id="error" role="alert"></p>
</main>
<script src="/cloud/app.js"></script>
</body>
</html>`;
}

const EMAIL_STEPS = `
<section class="step" id="email-step" hidden>
<form id="email-form">
<label for="email">Email</label>
<input id="email" type="email" autocomplete="email" required placeholder="you@example.com">
<button id="send" type="submit">Send code</button>
</form>
</section>
<section class="step" id="code-step" hidden>
<p>We sent a code to <strong id="sent-to"></strong>.</p>
<form id="code-form">
<label for="otp">Code</label>
<input id="otp" inputmode="numeric" autocomplete="one-time-code" required pattern="[0-9]{6,10}">
<button id="verify" type="submit">Sign in</button>
</form>
<button class="quiet" id="restart" type="button">Use a different email</button>
</section>
`;

export const DESKTOP_PAGE = htmlPage("Connect later.dog", "desktop", `
<h1>Connect later.dog on your computer</h1>
<p>Check that this code matches the one in later.dog.</p>
<div class="code" id="user-code"></div>
${EMAIL_STEPS}
<section class="step" id="approve-step" hidden>
<p>Connect <strong id="device"></strong> to your later.dog account?</p>
<button id="allow" type="button">Connect</button>
<button class="quiet" id="deny" type="button">This isn't me</button>
</section>
<section class="step" id="done-step" hidden>
<p class="status">Connected. You can go back to later.dog.</p>
</section>
<section class="step" id="denied-step" hidden>
<p class="status">Nothing was connected.</p>
</section>
<section class="step" id="expired-step" hidden>
<p class="status">This code has expired. Start again in later.dog.</p>
</section>
`);

export const ACCOUNT_PAGE = htmlPage("later.dog Cloud", "account", `
<h1>later.dog Cloud</h1>
${EMAIL_STEPS}
<section class="step" id="account-step" hidden>
<p>Signed in as <strong id="account-email"></strong></p>
<p class="status" id="home-status"></p>
<button class="quiet" id="sign-out" type="button">Sign out</button>
<button class="danger" id="delete" type="button">Delete account</button>
</section>
<section class="step" id="deleted-step" hidden>
<p class="status">Your account and your home are deleted.</p>
</section>
`);

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "cache-control": "no-store",
};

const PHONE_APP_HOSTS = new Set(["testflight.apple.com", "apps.apple.com"]);

export function phoneAppTarget(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && PHONE_APP_HOSTS.has(url.hostname) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export const PHONE_APP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>later.dog for iPhone</title>
<link rel="stylesheet" href="/cloud/style.css">
</head>
<body data-page="iphone">
<main>
<div class="brand">later.dog</div>
<h1>later.dog for iPhone</h1>
<p>later.dog for iPhone is in public beta on TestFlight.</p>
<p><a href="https://testflight.apple.com/join/UH46TVvC">Join the beta on TestFlight</a></p>
<p class="status">Sign in with the same email as on your Mac, and your dogs are there.</p>
</main>
</body>
</html>`;

export function cloudPage(request: Request, phoneApp: string | null = null): Response | null {
  if (request.method !== "GET") return null;
  const path = new URL(request.url).pathname;
  if (path === "/privacy") return new Response(PRIVACY_PAGE, { headers: HTML_HEADERS });
  if (path === "/terms") return new Response(TERMS_PAGE, { headers: HTML_HEADERS });
  if (path === "/iphone" || path === "/iphone/") {
    if (phoneApp) return new Response(null, { status: 302, headers: { location: phoneApp, "cache-control": "no-store" } });
    return new Response(PHONE_APP_PAGE, { headers: HTML_HEADERS });
  }
  if (path === "/cloud" || path === "/cloud/") return new Response(ACCOUNT_PAGE, { headers: HTML_HEADERS });
  if (path === "/cloud/desktop") return new Response(DESKTOP_PAGE, { headers: HTML_HEADERS });
  if (path === "/cloud/app.js") return new Response(SCRIPT, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
  if (path === "/cloud/style.css") return new Response(STYLE, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" } });
  return null;
}

