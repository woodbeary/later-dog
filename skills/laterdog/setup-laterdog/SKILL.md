---
name: setup-laterdog
description: "Clone, build, install and start later.dog on a Mac for the person you work for, hand them exactly the four steps only they can do, and prove the result."
---

# Set up later.dog

Use when someone says "set up later.dog for me", "install later.dog", or points you at github.com/woodbeary/later-dog. {{TOOLS}}

later.dog is a macOS desktop app (Apple silicon) for AI agents (the app calls them dogs) that run on the person's own ChatGPT, Claude or Grok
accounts, with an optional self-hosted cloud workspace that turns tasks into verified pull requests. Nothing here needs an
API key. Four things need the person's hands; everything else is yours.

## Rules

- Follow `AGENTS.md`: pnpm only, Node 24+, never verify against the person's live data when a fixture will do.
- Never type, read aloud or move a credential. Device codes, OAuth consents, macOS permission prompts and GitHub tokens
  are the person's; you prepare the exact step and say when it is their turn.
- Say what you verified and what you did not. "Fixture success does not qualify a live provider."

## Procedure

1. **Prerequisites.** `git`, Node 24 (`nvm` is fine: the repo has `.nvmrc`), pnpm 10.33 (`corepack enable && corepack
   prepare pnpm@10.33.0 --activate`). The provider CLIs the person will use: Codex (`npm i -g @openai/codex@0.154.0`),
   Claude Code (`npm i -g @anthropic-ai/claude-code`), Grok (`npm i -g @xai-official/grok`). Install them under the newest
   Node the machine has: a GUI launch searches nvm's bin directories newest first.
2. **Get the code.** `git clone https://github.com/woodbeary/later-dog.git && cd later-dog && pnpm install --frozen-lockfile`.
3. **Build and install the app.** `pnpm laterdog:package` → `release/mac-arm64/later.dog.app`; then
   `ditto release/mac-arm64/later.dog.app /Applications/later.dog.app && open -a later.dog`. If `swiftc` fails on this
   Mac the build still completes without voice dictation; say so. (Or use a release zip from GitHub: unzip, drag to
   Applications, right-click → Open the first time because it is unsigned.)
4. **Their turn, part 1 — sign in.** The welcome tour's providers step lists what was found. For each provider they
   want: ChatGPT plan uses Codex's device code (a URL and a code, confirmed in their browser), Claude opens a browser
   consent and pastes a code, Grok uses a device code. Tell them which provider, where the button is, and that the code
   expires in minutes. Do not start a sign-in they did not ask for.
5. **Their turn, part 2 — permissions.** If they want a dog to control this Mac ("This PC" in Dog's computer), macOS
   asks for Accessibility and Screen Recording; the browser inside the app needs nothing.
6. **First dog.** New dog → Starting role (chief of staff, engineer, nightly audit engineer, reviewer, project manager,
   inbox manager, intel scout, gatekeeper) → pick the provider that is Ready. Send one message and make sure a reply
   comes back; if the reply is a sign-in card, go back to step 4.
7. **Optional: the cloud workspace.** Only if they want tasks turned into pull requests. Follow
   `docs/laterdog/cloudflare.md` (their Cloudflare account, `wrangler login` is their click; the app secrets
   `LATERDOG_TOKEN` and `LATERDOG_BACKUP_KEY` you may generate with `openssl rand`; **GitHub: run `pnpm laterdog:github` (or use Workspace → Connect GitHub) — it prints a code from GitHub's device sign-in
   inside the container; the person enters it at github.com/login/device and authorizes; never move their token yourself**). Save `~/.laterdog/supervisor.json`
   (`{ "url": "https://…workers.dev", "tokenFile": "~/.laterdog/supervisor-token" }`), run `pnpm laterdog:login` (device
   code, theirs), then `pnpm laterdog:doctor` must show `profile.authenticated: true` and `github.authenticated: true`.
   Register a repository in Workspace with its published Codex Cloud environment ID (from the Codex web UI, theirs).

## Prove it

- `pnpm laterdog:doctor` output (when a supervisor is connected), the About dialog's version, and one real reply from a
  dog. Keep screenshots or the exact command output; do not describe what you did not see.
- Leave the person a short list: what works now, which of steps 4, 5 and 7 are still theirs, and the one command to
  restart the app.
