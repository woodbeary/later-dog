# Changelog

## 0.3.16 — 2026-10-12

- **Open the computer and it turns on.** Opening a dog's computer starts it if it never started and wakes it if it's asleep, so you see its screen right away.
- The + menu's apps entry reads **Connect apps**, like the Apps page.
- **Keep going when an account runs out** shows once you have two accounts to switch between.

## 0.3.15 — 2026-10-12

- **Model and effort the way Claude Code does them.** Beside the message field, the model button lists a few models by name, the current one checked and the others numbered (press 1-4), with More models for the rest. It shows every model you can use now: the free Kimi K2.6 and Grok 4.3, and the models of any account you've signed in. Effort is its own button: a Faster to Smarter slider with the recommended level marked.
- **Choose which models show**, as in Cursor: Settings, Models lists every model of your signed-in accounts with a switch, and a chat's model menu shows only the ones switched on.
- **Fast mode** for the models that have it (Claude's Opus models, through Claude Code's own fast mode), in the effort popup.
- **Accounts on top, nothing repeated.** The chat header's account button lists the accounts you're signed in to (and the free Kimi and Grok), under the names you gave them, with Add account at the end.
- **Sign in when you need to.** Pick Claude or ChatGPT before you've signed in and the first message you send opens their sign-in; it sends once you're in.
- **One + button.** Attach files, connect apps and choose permissions from a single + beside the message field, in place of the paperclip and the shield.
- **Voice mode is a setting.** The voice chat button shows only after you turn on Voice mode in Settings, General. Dictation's mic stays where it was.
- **Voice notes are never lost.** Dictating also saves the recording on your Mac; if turning it into text fails, Retry transcribes the saved note into the message box. The last ten notes are kept.

## 0.3.14 — 2026-10-12

- **Pick the model by name.** The free models show as **Kimi** and **Grok** in the account list, each with its own mark, instead of one "later.dog" entry. Both run free through the trial. If you sign in to Grok yourself, your own account takes over that row.
- **Signing in is one button.** Choosing Claude or ChatGPT before you've signed in shows a single **Sign in** button that opens Settings straight on that provider's sign-in. Claude finishes in your browser and comes back by itself, with no code to paste. If Claude or Codex isn't on your Mac yet, it's fetched first.
- **Every dog has its own computer.** The "Where it works" picker and the Computer tab are gone. A dog whose computer is off gets one button to turn it back on.
- **A simpler Library.** Tricks and what your dog remembers, in plain words: one switch for memory, the things it remembers as a list you can forget one by one, and **Teach a trick** takes a sentence, which your dog turns into a trick in chat. The memory files are still one click away.
- **The free trial's one computer.** When another dog already has it, later.dog offers later.dog Cloud instead of asking you to delete a computer.
- **The tour waits its turn.** Its first tip shows once your dog has finished replying, not over the answer as it arrives.
- **Waiting on you reads that way.** While a dog's question is open, the message field says "Message Miso" with no stop button.
- The tour no longer says every chat runs on your machine.

## 0.3.13 — 2026-10-12

- **A launch that feels intended.** later.dog opens on its golden dog and fades into the app once everything is ready, the same on a fast start or a slow network, and a dog's screen fades in on its first frame instead of popping in.
- **Pick a model, not a product.** The free models show by name (Kimi K2.6, Grok 4.3) in the model picker, powered by later.dog, and the choice decides which one answers.
- **No "I'm done" button** on a dog's computer: closing the screen hands it back.
- **Account on top, model below.** The chat header shows which account the chat runs on; the model sits by the message field and opens straight to the models.
- **Fewer controls.** The voice chat icon has no menu beside the message field (call style lives in Settings), and "More ways to run dogs" is one button to Settings instead of a long list.

## 0.3.12 — 2026-10-12

- **Straight into a chat.** A new later.dog asks your name and lets you pick a dog, then opens its chat already running on later.dog AI. No AI or sign-in step: the free trial starts by itself, and Claude or ChatGPT sign-ins wait in Settings for when you want them.
- **Open a dog's computer and it boots.** Clicking the computer button starts the dog's cloud computer and shows its screen. A dog you put on this Mac keeps it.
- **Model and effort by the message field**, like other coding apps, instead of in the chat's header.
- **A calmer sidebar.** The server switcher only appears when you're connected to another server, and the update icon sits at the bottom next to Apps.
- **Accounts:** the drag handle to reorder them is always visible, and "Keep going when an account runs out" lives in Settings.
- **No double steps.** A second click on Continue no longer skips the next step of the welcome before you've seen it.
- The Activity panel is gone from the chat menu.

## 0.3.11 — 2026-10-11

- **Signed and notarized.** later.dog is signed with an Apple Developer ID and notarized by Apple, so it opens without the Open Anyway step.
- **Download this one by hand.** 0.3.11 can't install itself over 0.3.9 or earlier, because the signature changed. Download it once from later.dog and drag it over the old app; your dogs and chats stay. Later versions install themselves again.
- **Chat right away, free.** Start the free trial and your dogs can chat and use their computer on later.dog AI, with no account to sign in to. It runs Kimi K2.6 on Cloudflare, later.dog keeps none of your prompts, and it comes with a daily allowance. When that runs out, sign in to Claude or ChatGPT to keep going.
- **Voice in the free trial.** Read aloud and spoken replies work during the free trial with no key, in natural voices running on Cloudflare.
- **No Node needed.** On a Mac without Node, **Sign in** for Claude or ChatGPT installs them straight from Anthropic and OpenAI. Codex's download is checked against OpenAI's published checksum before it runs.
- **Dogs that make dogs hand over the work.** A dog made by another dog starts with its creator's apps and approval level (never more, and never Full access), and the creator hands it the job right away, so you don't have to approve every step in a thread you aren't watching.
- **Plain words while a dog works.** "Checking with Scout", "Making Scout", "Working in Gmail" and "Sniffing around the web" instead of tool names like "Running create_bot".
- **Cards the size of a message.** Questions, choices, approvals, app sign-ins, keys and cloud tasks are compact cards at bubble width instead of panels that filled the chat, and a dog's screenshots are small thumbnails that open full size. A question with one answer takes one click, and the tour waits until you've answered it.
- **Approvals ask one question.** "Let Scout run a command?" with **Don't allow**, **Always allow** and **Allow once**, and a small × to stop. Tool names are gone from the card in the chat, and details are one click away.
- **Group chats start right away.** No setup card before the first message: the first dog leads and @mentions bring others in. Replies no longer show a "Picked by…" percentage, and a teammate's reply chip shows the first line of what it said.
- **Smarter group chats during the free trial.** Each message goes to the best-fit dog, decided by Cloudflare's Clef model, with nothing to set up. Your own keys always come first.
- **Keep going after the trial.** When the free minutes run out, **Keep going for $10/month** puts your dogs on later.dog Cloud: a cloud computer, 40 hours a month, paid through Square and cancellable anytime from Settings. It appears once sign-ups open.
- Shorter wording across setup, apps and approvals, and the README says plainly what stays on your Mac.

## 0.3.9 — 2026-10-11

- **Black and white.** Buttons are black in light mode and white in dark mode, and new dogs start as the classic golden dog. Pick any color for a dog in its settings.
- **Feels like a Mac app.** The system font, 14-point chat text, rounder bubbles and a softer message box with a hairline edge.
- **Your messages take your dog's color.** Each chat's bubbles match the dog you're talking to.
- **Calmer thinking.** The green dot by the dog's name is gone; the dog's face and a soft moving line under the last message show it's working.
- **Softer cards.** A failed turn reads like a normal message with a quiet Try again. A permission request asks a plain question, keeps the details one click away, and makes Always allow the main button where it's offered.
- @mentions show the dog's name in its color, without the box and underline.
- **Simpler setup.** The welcome tour asks only for Claude or ChatGPT, with one **Sign in** button each that installs what it needs.
- **Only your accounts.** Settings lists the accounts you added, each with an X to remove it, and nothing for ones you never added.
- **The screen is the button.** Click a dog's cloud screen to open it, and use it right away. It goes to sleep by itself when nobody uses it. **Take over** appears only when the dog asks for your help.
- **The free cloud computer starts itself.** After the quick check in your browser, the dog moves to its cloud computer and starts it. No more clicks in the app.
- A dog working on This Mac no longer shows a copy of your own screen in its Computer panel.
- The step dots in the welcome tour line up.

## 0.3.8 — 2026-10-11

- A dog working on This Mac now offers **Try a cloud computer free** in its Computer panel too, under its screen. Before, only a dog with no computer showed it, so most people never saw the trial outside Settings.
- The Cursor row shows Cursor's own logo. It was a plain pointer arrow.
- When an update doesn't finish, the update icon offers the newest version on later.dog as well as **Try again**.

## 0.3.7 — 2026-10-11

- Once your free trial starts, a dog with no computer shows **Use the free cloud computer** in its Computer panel, with the minutes left. Before, the trial was running but the panel still said the dog had no screen until you picked Cloud computer in its settings.

## 0.3.6 — 2026-10-11

- **Try a cloud computer free.** A dog with no computer offers **Try a cloud computer free** in its Computer panel: 30 minutes on a later.dog cloud computer, to use within 7 days. No account and no card; a quick check in your browser starts it. Settings, Computer shows the trial too, with the minutes left.
- **New dogs start Off-leash.** A dog you make acts, then tells you, instead of asking before every command. Pick Heel in the chat's approval menu for a dog that should check with you first. Dogs you already have keep their setting, and a default you saved yourself still wins.
- Your first dog starts Off-leash too, once you finish the welcome tour.
- A cloud computer that isn't set up says so ("Not set up") instead of "Coming soon".

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
