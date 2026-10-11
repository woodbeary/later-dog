# Changelog

## 0.3.5 — 2026-10-11

### Cloud tasks you can watch
- When a dog sends work to the cloud, a **Cloud task** card appears in the chat that started it. It shows what the task is doing right now (Setting up, Working, Ready for review, Needs attention), how long it has run, and its pull request once it has one.
- Click a card to open the task beside the chat: its progress step by step, its plan, the files it changed (open one to see the change) and **Watch screen** to see its live screen while it runs. **Open draft PR** publishes the result, and **Stop** ends a running task and deletes its cloud computer.
- A dog's Computer panel lists its cloud tasks, so a dog working in the cloud no longer shows an empty screen.
- Any GitHub repository works without setup: the first task connects it, starts from its default branch and installs its dependencies itself.
- A dog that sends work to the cloud without saying where uses later.dog Cloud when it is set up.
- A dog gets a short receipt when it sends work to the cloud, instead of its whole request read back to it.
- When a cloud task finishes or needs attention, the chat shows one line saying so ("Cloud task opened a draft PR") that opens the task, instead of the message later.dog sends the dog.

## 0.3.4 — 2026-10-10

- A dog can use later.dog's cloud tools without asking you each time: checking the workspace, sending work to the cloud, following a job, and publishing a draft PR. Before, the first call asked for approval, and in Auto mode Claude's safety check could refuse it outright. Merging a pull request still asks you first.
- Asked what it has been working on, a dog checks the repository, its pull requests and its cloud jobs first, and marks anything it only remembers as possibly out of date. Before, it could report work as unfinished after it had already shipped.
- A dog no longer tells you cloud jobs need keys when later.dog Cloud is already set up.

## 0.3.3 — 2026-10-10

Everything new and better since 0.3.0.

### Simpler settings
- later.dog updates itself. A new version downloads in the background, and a small icon appears at the top of the sidebar: a ring while it downloads, then a highlighted arrow when it's ready. Click it to see what's new and **Restart to update**, whenever suits you. If a dog is still working, it says so first. **Check for updates** is in the menu under your name and in Settings, Updates.
- 0.3.2 and earlier can't update themselves. Download 0.3.3 once, and later versions arrive by themselves.
- Settings is four pages: General, Computer, Usage and Updates. Advanced mode, Engines and Model providers, the API keys page, Servers, the Permissions page, backups and other rarely used pages are gone.
- **Theme** is one menu: System, Light and Dark. System follows your computer. A theme you picked before stays. A new install follows your computer instead of starting dark.
- **Language** and **Notification sounds** have shorter help text.
- **Apps** is simpler: the Composio key is one line with **Add key**, apps that sign in by themselves connect without it, and **MCP servers** is now **Custom** and shows only your own servers.
- **Connect your phone** and **Use on your phone** are hidden, because there's no phone app yet. A phone or browser you already paired keeps working, and `laterdog sessions` lists them. `laterdog sessions revoke ID` signs one out.
- Keep separate setups, such as Personal and Business, and switch between them with **Switch profile** in the menu under your name. Each profile has its own dogs, chats and saved keys, and profiles you're not looking at keep running. **Add profile** sets one up in a few seconds, **Edit profiles** renames or removes one, and you can have up to 8. A new profile starts with your name, your email and your place in the tour, and starts fresh otherwise. Profiles are in the Mac app only, and they keep your setups apart, not people who share this Mac.

### Accounts and usage limits
- Claude and ChatGPT accounts sit in one list in Settings, General, each with its name, email, plan and usage.
- The menu on the model chip is short: it opens on your accounts, one line each with its usage, and the model you're using is one line under them. Tap it to change the model or effort. With one account it opens straight on the models.
- A usage ring on the chip turns amber at 75% and red at 90%.
- When an account hits a limit, the chat says which limit and when it resets, and offers **Continue on** another account or **Add another account**.
- With **Keep going when an account runs out** on, a chat whose accounts are all out picks up by itself after the soonest reset. Drag an account up or down, or press Alt+↑ or Alt+↓ on it, to change the order it moves through. Claude accounts move among Claude, ChatGPT among ChatGPT.
- An account that isn't signed in stays out of the menu unless a dog is using it. An account whose usage can't be read says **Couldn't check usage**.
- **Usage** lists only the accounts you sign in to. **Estimated cost so far** comes from the same record as **History**, for the last 12 months, so the two agree.

### Chatting with dogs
- Hovering a dog's message shows **Copy**, a treat and **Reply**, with **⋯** for the rest: **Read aloud**, **View source**, **Retry** and **Pin to top**. Your own messages show **Edit**, **Copy** and **Reply**. **Read aloud** shows only once a voice is ready.
- The message box is one slim line until you need more. Long messages get the full width, with the buttons underneath. Pictures, files and the message you're answering sit inside the box.
- A message takes up to 4 pictures. Picking, pasting or dropping more adds the first 4 and says so.
- A picture you add while a dog works goes into the running turn, the same as words. A queued picture shows as a small thumbnail.
- Pictures you send sit in their own row on the right. Your words get a bubble that fits them, and a message of only pictures has no bubble.
- A dog's question has an × in its corner. Close it to skip the question and type your own message instead. An answered question shows the question once.
- When a Claude dog asks to write or edit a file, the approval shows the file's path and the text going in. An edit shows the lines taken out with `-` and the lines put in with `+`.
- The sidebar and the "finished" notification show a dog's reply as plain words, not formatting marks.
- Search shows a dog's whole name beside a matching message.
- **Thinking** shows under a dog's message when it keeps working, and goes away once it has answered.

### Dogs' computers
- The Computer panel is one view: **Computer**, a green dot while the dog is working there, and a close button. It shows the one place the dog works.
- Where a dog works is chosen in the dog's settings, under **Computer**: Auto, Cloud computer, This Mac or Off, with a line saying what each means and **Open Computer panel** under it.
- Cloud computers are coming soon.
- The built-in browser and the Local VM were removed. Dogs set to them now use Auto.

### Fixes
- A dog made before Claude or ChatGPT was installed gets a model once one is. Before, its model chip was blank and every message failed.
- A dog's answer no longer hides inside **Worked for**. Only what a dog says on its way to using a tool, such as "Let me check", folds away.
- If later.dog's background server stops, the app notices and restarts it, for each profile's server too. Before, dogs stopped answering until you quit and reopened later.dog.
- The tour's tip no longer shows on top of other windows, menus or pop-ups, and Escape closing one no longer ends the tour.
- About, the Full access and computer warnings, and the allowed commands list now cover the whole window, so **Jump to latest** can't show on top of them.
- The message box hint while a dog works is plainer, for example "Message Biscuit while it works", in all ten languages.
- My Cloud's sign-in screen offers **Use an Anthropic API key** again.
- Messages that sent you to Settings pages that no longer exist now point at what's there.
- A screen reader now hears "Pepper has a question" when a dog asks you something.

## 0.3.2 — 2026-10-09

### Fixes
- Pictures a dog takes while it works, such as screenshots, show in the chat the moment it takes them, in the place it took them. Before, they waited for the end of the turn, piled up at the end of the dog's last reply, and pressing Stop lost most of them.

### Docs
- The verification guides no longer point at tests and screens removed in 0.3.0.

## 0.3.1 — 2026-10-09

### Fixes
- A working dog's messages show up as they arrive again. A message you sent while it worked could leave the chat stuck at an earlier point if it was queued (a message with a picture always is) or failed. Everything the dog said after that stayed hidden until you pressed Stop and sent something new.

## 0.3.0 — 2026-10-09

later.dog made simpler: four settings pages, one list of accounts, and a shorter model menu.

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
