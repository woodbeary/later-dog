<p align="center"><img src="public/laterdog.svg" width="96" alt="later.dog"></p>

<h1 align="center">later.dog</h1>

<p align="center">AI dogs that do real work, on your Mac and your iPhone. Free and open source.</p>

<p align="center"><a href="https://later.dog">later.dog</a> · <a href="https://github.com/woodbeary/later-dog/releases/latest">Download for Mac</a> · <a href="docs/laterdog/README.md">User guide</a></p>

## What it is

- **Sign in and go.** Enter your email, type the code, and your dogs are there. No keys, no setup.
- **One workspace, in your Cloud home.** Your dogs, chats, routines and memory live in an always-on home. The Mac and
  the iPhone are two screens onto the same place.
- **Every dog has a computer.** Each dog gets its own cloud desktop that you can watch or take over. It sleeps when idle.
- **Your Mac is a second computer.** While it is signed in, your dogs can use it too, for a file in Downloads or an app
  only you have.
- **Bring your own AI, or start free.** Sign in to Claude, ChatGPT, Grok or Cursor with the plan you already pay for.
  Or start on the included free AI: Kimi K2.6, with Grok as backup.
- **Voice.** Talk to a dog and hear it answer, with Aura-2 voices (and ElevenLabs where it is switched on).
- **Runs while you're away.** Ask a dog for a routine ("every morning at 8, plan my day") and it runs on time.
- **Free to start.** The app is free, and signing in gives you a Cloud home with an included allowance of computer
  time, AI and voice. Without an account, the app can offer the same allowance as a $10-a-month plan.

## How it works

<p align="center"><a href="docs/assets/architecture.svg"><img src="docs/assets/architecture.svg" width="900" alt="The Mac and the iPhone sign in at accounts.later.dog and open one Cloud home: a Worker, a Durable Object and a Container running the later.dog server. Your own Claude, ChatGPT, Grok or Cursor sign-ins run in that Container and talk straight to the provider. cloud.later.dog gives each dog its own computer, the included Kimi K2.6 with Grok backup through AI Gateway, and voice (Aura-2 or ElevenLabs). The signed-in Mac is a second computer."></a></p>

Every hosted part runs on Cloudflare. Without an account, the Mac runs dogs on its own.

## Screenshots

Current screenshots of the app live in [`docs/assets/screenshots/`](docs/assets/screenshots/README.md), taken from an
isolated fixture, never from someone's real data.

## Install

- **Mac (Apple silicon):** download `later.dog-macOS-arm64.dmg` from the
  [latest release](https://github.com/woodbeary/later-dog/releases/latest), drag it to Applications and open it. It is
  signed and notarized, and it updates itself (**Restart to update**).
- **iPhone:** a TestFlight beta, linked from [later.dog](https://later.dog). Sign in with the same email.

## Build from source

```sh
git clone https://github.com/woodbeary/later-dog.git && cd later-dog
pnpm install --frozen-lockfile        # Node 24 and pnpm 10.33
pnpm laterdog:package                 # unsigned local build → release/mac-arm64/later.dog.app
```

Coding agents: start with [`AGENTS.md`](AGENTS.md), the
[setup skill](skills/laterdog/setup-laterdog/SKILL.md) and [`llms.txt`](llms.txt).

## Project layout

| Path | What |
| --- | --- |
| `src/`, `server/`, `electron/` | The desktop app and the later.dog server (the same server runs in the Cloud home) |
| `deploy/laterdog/home/` | The Cloud home: Worker, Durable Object and Container |
| `deploy/laterdog/computers/` | `cloud.later.dog`: each dog's computer, the included AI, voice, trials and the plan |
| `cloudflare/control-plane/` | `accounts.later.dog`: email sign-in and accounts |
| `skills/laterdog/` | Canonical agent skills, exported by `pnpm laterdog:skills` |
| `docs/` | [User guide](docs/laterdog/README.md), [Cloud home contract](docs/cloud-pro.md), [verification](docs/verification/README.md) |

## What is proven, and what is not

CI runs lint, typecheck, the vitest suite, the Electron tests and the builds on every pull request.
[docs/verification/README.md](docs/verification/README.md) says how each change is proven on an isolated fixture, and
[docs/laterdog/verification.md](docs/laterdog/verification.md) keeps the live records. Fixture success never qualifies
a live provider.

## Support, security, license

- later.dog stays free; sponsorships help, and a share goes to animal rescue ([support.md](docs/laterdog/support.md)).
- Pull requests welcome: [CONTRIBUTING.md](CONTRIBUTING.md). Security problems: [SECURITY.md](SECURITY.md), never a
  public issue.
- Apache-2.0, see [LICENSE](LICENSE). Credits: [NOTICE](NOTICE).
