# Changelog

## 0.3.3 — unreleased

### Updates
- later.dog updates itself. A new version downloads in the background, and a small icon appears at the top of the sidebar: a ring while it downloads, then a highlighted arrow when it's ready. Click it to see what's new and **Restart to update**, now or whenever suits you. If a dog is still working, it says so before you restart.
- The icon replaces the floating update card and the badge on your name. **Check for updates** stays in the menu under your name and in Settings, Updates.
- 0.3.2 and earlier can't update themselves. Download 0.3.3 once, and later versions arrive by themselves.
- Tried for real: a signed 0.3.3 found a test 0.3.4, downloaded it, showed the icon, and restarted as 0.3.4 after **Restart to update**. That run caught a missing file that stopped every download, now fixed. Not tried yet: an update from a real GitHub release, or of a copy in Applications.
- How to publish an update: [docs/laterdog/releasing.md](docs/laterdog/releasing.md).

### Accounts
- The menu on the model chip is short now. It opens on your accounts, one line each with its usage, and the model you're using is a single line under them. Tap that line to change the model or effort; **‹ Accounts** goes back. With one account it opens straight on the models. Before, accounts, models and effort were all in one menu about 1,000px tall. With three accounts it's now 220px.
- Drag an account up or down to change the order **Keep going when an account runs out** moves through, or press Alt+↑ or Alt+↓ on it. An account moves among its own kind only, Claude with Claude and ChatGPT with ChatGPT. Dragging needs a mouse or trackpad.
- An account that isn't signed in stays out of the menu unless a dog is using it. It's still in Settings, General, Accounts.
- Tried in the browser fixture with three Claude accounts: dragging one to the top and Alt+↓ both saved the new order. Not tried yet in the installed app.

### Menu under your name
- **Connect your phone** and **Use on your phone** are gone. There's no phone app yet, so the phone features are hidden for now. The menu is Settings, Keyboard shortcuts, the update line, About, Help Center and Send Feedback. The note after a copy to My Cloud doesn't mention your phone any more either.
- A phone or browser you already paired keeps working. The app no longer lists paired devices: `laterdog sessions` lists them, and `laterdog sessions revoke ID` signs one out.
- Tried in the browser fixture: the menu has five lines and is 212px tall. The fixture has no updater, so its update line didn't show. Not tried yet in the installed app.

### Computer panel
- The Computer panel is one view now, like Grok Bot's: **Computer**, a green dot while the dog is working there, and a close button. The Computer, Browser and Files tabs are gone.
- It shows the one place the dog works. A dog set to Browser shows the browser there; a dog on a cloud computer, a Local VM or this computer shows that screen. A dog uses one place per message, so there's nothing to switch between.
- Where a dog works is chosen in the dog's settings, under **Computer**: one list (Auto, Cloud computer, Local VM, This Mac, Browser, Off) and a line saying what the choice means, with **Open Computer panel** under it. The six cards and the "where it works" block are gone from the panel.
- A dog set to Off says it has no screen and has a button to choose where it works. When a dog's browser is switched off, the panel says so and has **Turn on the browser**. Only an Admin gets the button; anyone else is told to ask an Admin.
- The first time a dog works in the browser, the panel offers its one-time download (about 160 MB) right there. Before, the message pointed to a Browser tab. Browser can be chosen before that download, and an Admin can choose it while the browser is off.
- Dogs are told the browser is "in the Computer panel" instead of "the Browser tab".
- Gone for now: the note about a chat held to a different place (a message that fails there still offers to switch back), opening the built-in browser for a dog that works somewhere else, and the Files tab's list of changed files. The working folder is in the dog's settings, and each finished message's summary in the chat still counts the files it changed.
- Tried in the browser fixture: Browser, Off and Auto in the panel, and the list in the dog's settings. Not tried yet in the installed app.

### Fixes
- A picture you add while a dog works goes into the running turn, the same as words. Claude and ChatGPT dogs see it right away; Steer on a queued picture works too. Before, any message with a picture waited for the turn to end, and its queue row showed a file path instead of the picture.
- A queued picture shows as a small thumbnail with "A picture" or "2 pictures" when there are no words.
- A dog's question has an × in its corner. Close it to skip the question and type your own message instead. A new dog's first question has one too. The dog is told you closed it and stops waiting for an answer. Closing works after a restart as well.
- A message takes up to 4 pictures, and the message box now stops there. Picking, pasting or dropping more adds the first 4 and says so. Before, they all went in and sending failed.
- The message box hint while a dog works is plainer, for example "Message Biscuit while it works", in all ten languages.
- The message box works like Grok Bot's. It is one slim line until you need more. Long messages get the full width, with the buttons underneath. Pictures, files, the 4-picture note and the message you're answering all sit inside the box instead of floating above it.
- The 4-picture note goes away once the message is sent.
- Pictures you send sit in their own row on the right, side by side at one height, like Grok Bot. Your words get a bubble that fits them, and a message that's only pictures has no bubble. Before, one picture sat at the left of a wide empty box, and pictures with words made a very wide bubble. Rooms show them the same way.
- About, the Full access and computer warnings, and the allowed commands list now cover the whole window. Before, **Jump to latest** could show on top of them and hide About's Support link.

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
