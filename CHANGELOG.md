# Changelog

## 0.3.3 — unreleased

### Updates
- later.dog updates itself. A new version downloads in the background, and a small icon appears at the top of the sidebar: a ring while it downloads, then a highlighted arrow when it's ready. Click it to see what's new and **Restart to update**, now or whenever suits you. If a dog is still working, it says so before you restart.
- The icon replaces the floating update card and the badge on your name. **Check for updates** stays in the menu under your name and in Settings, Updates.
- 0.3.2 and earlier can't update themselves. Download 0.3.3 once, and later versions arrive by themselves.
- Not yet tried on a real install: the tests cover each step, but a real update from one signed build to the next hasn't run yet.

### Fixes
- A picture you add while a dog works goes into the running turn, the same as words. Claude and ChatGPT dogs see it right away; Steer on a queued picture works too. Before, any message with a picture waited for the turn to end, and its queue row showed a file path instead of the picture.
- A queued picture shows as a small thumbnail with "A picture" or "2 pictures" when there are no words.

## 0.3.2 — 2026-10-09

### Fixes
- Pictures a dog takes while it works, such as screenshots, show in the chat the moment it takes them, in the place it took them. Before, they waited for the end of the turn, piled up at the end of the dog's last reply, and pressing Stop lost most of them.

### Docs
- The verification guides no longer point at tests and screens removed in 0.3.0.

## 0.3.1 — 2026-10-09

### Fixes
- A working dog's messages show up as they arrive again. A message you sent while it worked could leave the chat stuck at an earlier point if it was queued (a message with a picture always is) or failed. Everything the dog said after that stayed hidden until you pressed Stop and sent something new.

## 0.3.0 — checkpoint, 2026-10-09

later.dog made as simple as Grok Bot. This is a review build from the branch `biscuit/simplify-wording` (tag `checkpoint-2026-10-09`): not merged and not released. What was checked, what wasn't, and what's next: [docs/laterdog/checkpoint-2026-10-09.md](docs/laterdog/checkpoint-2026-10-09.md).

### Settings: four pages
- **General:** your accounts, saved API keys (Change key), Profile (your name, About me), Appearance (theme, language, notification sounds), and System (microphone, analytics) when there is something to show.
- **Computer:** this Mac's computer-control permissions, the Local VM (Start, Open, Reset), cloud computers, and the built-in browser switch.
- **Usage:** each account's usage, the estimated cost so far, what each dog spent, and history by dog, model or day with CSV export.
- **Updates:** the version, Check for updates, and Restart to update.
- **Gone:** Advanced mode, Engines and Model providers, the API keys page, the decision model, the Tricks page, Servers, the Permissions page, the later.dog Cloud account, Organization, backups, People, Activity, installations, Experimental, Remote access, custom domain, lending, and the floating run card.

### Accounts
- Claude and ChatGPT accounts sit in one list. Each shows its name (rename inline), email, plan, a 5-hour usage bar and a weekly caption. Add account takes three steps: pick Claude or ChatGPT, name it, sign in in the browser.
- The model picker opens on your accounts with their usage, and one tap switches account. The chip has a usage ring that turns amber at 75% and red at 90%.
- When an account hits a limit, the chat says which limit and when it resets, and offers **Continue on** another account or **Add another account**.
- With **Keep going when an account runs out** on, a conversation whose accounts are all out picks up by itself after the soonest reset.
- A message sent during a limit waits behind the ones already held.

### Dogs
- The dog editor has three tabs:
  - **Details:** breed and colour, name, label, instructions, and what it runs on.
  - **Library:** tricks, memory, and what it made.
  - **Computer:** where it works, with a link to the Computer panel.
- A new dog needs only a name and what it should help with. The dog speaks first.
- Duplicating a dog keeps its breed and colour.

### Chat
- While a dog works, the arrow beside Send offers Steer now, Queue, or Stop and send.
- The model and account can change while a dog works. The change applies from the next reply.
- The sidebar and the chat show the same face for a working dog, and the chat header holds still.

### Launch and menus
- No permission prompts at launch. Accessibility and Screen Recording are asked for in the Computer panel when a dog needs them (PR #1).
- Connect your phone lives in the menu under your name. "Connect to a server…" and "Sign in with your organization…" are gone from the app menu.

### Fixes
- A Claude sign-in with a pasted code no longer reads as failed.
- An organization link no longer leaves Settings opening on every launch.

### Under the hood
- Every code comment this branch added is gone. Upstream comments remain for now.
- The continue-on route lives in `server/routes/continue-on.ts`.
- Compared with `main`: 430 files changed, about 9,000 lines added and 43,000 removed.
