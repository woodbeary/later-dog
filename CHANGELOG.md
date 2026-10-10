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

### Profiles
- Keep separate setups, such as Personal, Business and Business 2, and switch between them with **Switch profile** in the menu under your name. Each profile has its own dogs, chats and saved keys. Profiles you're not looking at keep running, so a dog working in Business carries on while you're in Personal.
- **Add profile** asks for a name and sets the profile up, which takes a few seconds. **Edit profiles** renames or removes one. Removing a profile deletes its saved keys and moves its dogs and chats to the Trash. Personal and the profile you're in can't be removed. You can have up to 8 profiles.
- Once you have more than one, the profile you're in shows under your name in the sidebar.
- A new profile starts with your name, your email and how far you got through the tour, copied from the profile you're in. It doesn't ask your name or show the welcome again. Nothing else is copied: its dogs, chats, keys and settings start fresh.
- If a profile doesn't start, its line in the menu says so: choose it again to try again. If the profile you're in stops, later.dog shows Personal and says why.
- Limits for now:
  - Only the profile you're looking at sends notifications and counts unread messages.
  - Cloud, servers, backups, sharing, waking the Mac for routines, managed connected apps and Local VM viewers stay with Personal. In another profile, connected apps need that profile's own Composio key.
  - Control of this Mac is shared by every profile.
  - Each profile runs its own copy of later.dog's server, so each one uses its own memory.
  - A new profile starts with this Mac's own Claude and ChatGPT sign-ins. Accounts you add in a profile stay in that profile.
  - Profiles keep your setups apart. They don't keep people who share this Mac apart.
  - Appearance and other choices kept in the window, such as theme, fonts, language, notifications and the sidebar, start at their defaults in a new profile.
  - Profiles are in the Mac app only.
  - A profile's data is in `~/.laterdog-profiles`. A removed profile's browser data stays in `~/.agent-browser`.
- Tried for real in a test copy of the 0.3.3 Mac app: adding Business opened it in about 2 seconds with its own first dog, Business kept running after switching back to Personal, and renaming and removing worked. In the 0.3.3 preview build, the tour's tip stepped aside while Settings or Add profile was open, and Escape closed Settings without ending the tour. Starting with your name isn't tried in a build yet.

### Computer panel
- The Computer panel is one view now, like Grok Bot's: **Computer**, a green dot while the dog is working there, and a close button. The Computer, Browser and Files tabs are gone.
- It shows the one place the dog works. A dog set to Browser shows the browser there; a dog on a cloud computer, a Local VM or this computer shows that screen. A dog uses one place per message, so there's nothing to switch between.
- Where a dog works is chosen in the dog's settings, under **Computer**: one list (Auto, Cloud computer, Local VM, This Mac, Browser, Off) and a line saying what the choice means, with **Open Computer panel** under it. The six cards and the "where it works" block are gone from the panel.
- A dog set to Off says it has no screen and has a button to choose where it works. When a dog's browser is switched off, the panel says so and has **Turn on the browser**. Only an Admin gets the button; anyone else is told to ask an Admin.
- The first time a dog works in the browser, the panel offers its one-time download (about 160 MB) right there. Before, the message pointed to a Browser tab. Browser can be chosen before that download, and an Admin can choose it while the browser is off.
- Dogs are told the browser is "in the Computer panel" instead of "the Browser tab".
- Gone for now: the note about a chat held to a different place (a message that fails there still offers to switch back), opening the built-in browser for a dog that works somewhere else, and the Files tab's list of changed files. The working folder is in the dog's settings, and each finished message's summary in the chat still counts the files it changed.
- Tried in the browser fixture: Browser, Off and Auto in the panel, and the list in the dog's settings. Not tried yet in the installed app.

### Free trial
- A free trial of a cloud computer: 30 minutes, to use within 7 days, with no card and no account. It shows in Settings, Computer, Cloud computers, only while no cloud computers are set up. **Start free trial** opens a quick check in your browser. Once it passes, the trial is your cloud computer and Settings counts the minutes left. **End trial** asks first, then deletes the trial's computer.
- Each installation gets one trial, and each network one a week. A computer whose trial is used up or ended stops at once instead of retrying.
- The trial runs on later.dog's computers Worker, which keeps it off until it's switched on. This version offers no trial yet: it needs the Worker deployed with trials on, and its address in the app (see [the computers README](deploy/laterdog/computers/README.md#free-trials)).
- Tried in tests only: the Worker with a fake Cloudflare, and the app with a fake Worker. Not tried yet against a deployed Worker or a real Turnstile check.

### Fixes
- A picture you add while a dog works goes into the running turn, the same as words. Claude and ChatGPT dogs see it right away; Steer on a queued picture works too. Before, any message with a picture waited for the turn to end, and its queue row showed a file path instead of the picture.
- A queued picture shows as a small thumbnail with "A picture" or "2 pictures" when there are no words.
- A dog's question has an × in its corner. Close it to skip the question and type your own message instead. A new dog's first question has one too. The dog is told you closed it and stops waiting for an answer. Closing works after a restart as well.
- A message takes up to 4 pictures, and the message box now stops there. Picking, pasting or dropping more adds the first 4 and says so. Before, they all went in and sending failed.
- The message box hint while a dog works is plainer, for example "Message Biscuit while it works", in all ten languages.
- The message box works like Grok Bot's. It is one slim line until you need more. Long messages get the full width, with the buttons underneath. Pictures, files, the 4-picture note and the message you're answering all sit inside the box instead of floating above it.
- The 4-picture note goes away once the message is sent.
- Pictures you send sit in their own row on the right, side by side at one height, like Grok Bot. Your words get a bubble that fits them, and a message that's only pictures has no bubble. Before, one picture sat at the left of a wide empty box, and pictures with words made a very wide bubble. Rooms show them the same way.
- The tour's tip no longer shows on top of other windows, menus or pop-ups, such as Settings, Edit profiles, the menu under your name or the list of models. It steps aside while one is open and comes back when it closes. Pressing Escape to close one no longer ends the tour as well.
- About, the Full access and computer warnings, and the allowed commands list now cover the whole window. Before, **Jump to latest** could show on top of them and hide About's Support link.
- If later.dog's background server stops and the app isn't told, the app now notices and restarts it, for each profile's server too. It checks every 15 seconds and restarts only a server that has really ended. Before, the window stayed open with nothing behind it, and dogs stopped answering until you quit and reopened later.dog. This happened once with 0.3.2, on 2026-10-10; why that server stopped is still unknown. Tried in tests only, including with a real ended process. Not tried yet in the installed app.
- A dog's answer no longer hides inside **Worked for**. Only what a dog says on its way to using a tool, such as "Let me check", folds away. Before, a message sent while a dog worked could fold its whole answer into the chip and leave only its last line showing. Tried for real with Claude: an 80-line answer sent with a message mid-turn now stays in the chat.
- The sidebar and the "finished" notification show a dog's reply as plain words, not formatting marks like `##` and `- [x]`. Your own messages still show exactly as you typed them.
- When a Claude dog asks to write or edit a file, the approval shows the file's path and the text going in. An edit shows the lines taken out with `-` and the lines put in with `+`. Before, it showed one cut-off line of code, such as `{"file_path":"…/haiku.md","content":"Loyal paws padding\nTail wags like a metr`. A long change shows its first 2,000 characters, and a cut-off command or address now ends in "…" so you can tell there is more. Tried for real with Claude: writing a 3-line file showed its path and the 3 lines, and an edit showed `- Beagle` and `+ Poodle`.
- An answered question shows the question once. Before, a card with one question showed it again as "Q: …" above your answer. A card with several questions now lists each one with its answer, without the tabs. Tried for real with Claude, with one question and with two.
- A dog's lettered question card now says who is asking, such as "Pepper has a question", the same as its other question card. Before, it said "Your dog has a question". Tried for real with Claude.
- A screen reader now hears "Pepper has a question" when a dog asks you something, the same way it hears that a dog needs your approval. Before, it heard nothing, and it could still be holding the line about an earlier approval. Tried in tests only so far.
- My Cloud's sign-in screen offers **Use an Anthropic API key** again. It opens the same key card as the model picker. Before, this version had dropped the choice along with the old API keys page, while the screen still said an API key works best. Tried in tests only.
- Messages that sent you to Settings pages this version removed now point at what's there: the built-in browser (Settings, Computer, Built-in browser), a rejected Boat token (Settings, Computer, Cloud computers), a Local VM that isn't ready (Settings, Computer), a dog's tricks (the Library tab in its settings), and an expired My Cloud link. Phone control on a shared Local VM now says why it can't run, instead of naming a setting that no longer exists.
- Phone setup no longer says you can come back to it from the menu under your name, and a phone asking to take control no longer sends you to Connect your phone. Both left that menu in this version.

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
