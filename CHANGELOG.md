# Changelog

## 0.3.33 — 2026-10-14

- **Your Mac keeps its workspace when you sign in.** Your existing dogs and conversations stay selected, with saved server connections available under Settings → General → Advanced.
- **Phone sign-in connects to your Mac.** Adds account registration and automatic phone pairing through the managed companion connection while your Mac is awake.
- **Direct pairing stays available.** Phone app → Pair a device opens the existing local pairing flow for recovery.

## 0.3.31 — 2026-10-14

- **Email sign-in works on the Mac.** Fixes the request error that stopped Agree and continue from sending a code in 0.3.30.
- **Sign-in responds straight away.** A quick click after filling your email is accepted, and the button says Sending code while it waits. If sending fails, a clear message appears and you can retry.

## 0.3.30 — 2026-10-14

- **One account on your Mac and phone.** Sign in on the Mac with your email and a code, right inside later.dog, to open the same Cloud home as your phone.
- **Bring your Mac's dogs with you.** Moving into an empty Cloud home checks that your dogs arrived and keeps the Mac's copy. A home that already has dogs is never replaced.
- **Cloud computers wake faster.** The desktop link returns sooner after a sleeping computer starts running.
- **Longer voice notes.** Voice notes can run for up to 30 minutes, with Deepgram Nova-3 transcription through later.dog.
- **Progress stays compact.** Open the thinking row for a drawer of steps, tools and helper work without filling the conversation.
- **Read threads stay read.** Opening a thread marks the messages you saw together, and unread messages remain easy to find.
- **Renames follow the dog.** Current names appear in mentions and conversation references; changes to a teammate's profile still ask for confirmation.
- **Choices for each cloud job.** A job can use its own model, account and effort without changing a dog's defaults, and keeps a scrubbed trace for review.

## 0.3.29 — 2026-10-14

- **Quiet lines when dogs talk to each other.** You see one line, "Messaged ◯ Name", that opens their conversation, instead of extra chats.
- **Routines a dog makes show up in chat** as "Created routine ⏲ name", one click from Routines.
- **Mentions show the dog's face and colour,** and a renamed dog shows its new name everywhere.
- **Answered approvals fold** to one grey line: "Allowed once", "Always allowed", "Allowed for this chat" or "Denied". Allow once is the main button, and Always allow sits apart so you never grant it by habit.
- **Typing suggestions.** Grey words appear as you type, from your own phrases, dog names and commands, worked out on this Mac; Tab takes them. Turn on Smarter suggestions to let Cloudflare suggest the rest; it stays off unless you choose it.
- **One thinking row.** While a dog works you see one line with its face and what it is doing; click it for the steps. Updates it gives along the way fold into its reply, or turn on Show every update to see them all.
- **New messages are easy to find.** A New divider, "N new messages" pills above and below, Jump to latest and the End key, and your place stays put when messages arrive above it.
- **One steady green dot** shows a dog is working, everywhere it appears.
- **Sidebar lists open and close smoothly,** and a list you close stays closed.
- **Copy conversation ID** copies just the ID.
- **Batteries for every account.** Each account shows what is left as a battery with the time it refills; hover for the five-hour and weekly details and Manage usage.
- **Weekly usage and Switch account** sit in the menu under your name.
- **Picking a model keeps your account.** The model menu lists the models of the account in use; switch provider from the account button.
- **A quieter update.** A small "Downloading update" pill, then a blue Update button that names the version and warns you if a dog is still working.
- **Motion that feels right.** Menus grow from their button, sheets rise from the edge, messages slide in from their side, and buttons give a little squish when pressed. With Reduce Motion on, things fade instead.
- **Local tools work without pairing.** Claude Code, Codex and scripts on this Mac can talk to later.dog through a private key file. They can never approve anything, answer a dog's question, or reach a dog on Full access, and a dog sees their messages as coming from a tool, not from you.
- **Sends survive a dropped connection.** If the network blips, later.dog tries again without sending your message twice.
- **A full Mac gets plain words,** and a dog no longer gets stuck "working" after the disk fills up.
- **Approvals left open by a restart close** instead of looking like they still wait for you.

## 0.3.28 — 2026-10-14

- **Keep going on your other accounts.** When an account runs out, your dog carries on with the next account that has room, and a line in the chat says so, for example "Claude is recharging. Continuing on Codex." It keeps the model you chose for that engine.
- **Honest handoffs.** Work passed between dogs keeps going while it makes progress. It stops after 20 quiet minutes or 4 hours in all, says "Ran out of time" instead of "Stopped by you", and a Continue button picks up only what is unfinished.
- **One chat per teammate.** A dog talks to each teammate in one ongoing thread instead of opening a new one every time, and says so plainly when it reaches its limit.
- **Dogs find each other across packs.** A dog can reach and work with dogs in your other packs, within the teammates it is allowed to talk to.
- **Questions one at a time.** A card with several questions shows one at a time with Next and Back, options are lettered, and a single choice moves on by itself. Answered cards fold to one line with your answer.
- **See what helpers are doing.** A progress panel shows each helper dog's progress while it works.
- **A picture for every dog.** Make a profile picture for a dog from its settings or the chat.
- **Tap the sleeping dog** to wake a dog's computer.
- **Saving a key works again after a Keychain hiccup.** If the Keychain couldn't be read when later.dog started, it now recovers, keeps the key you typed if saving fails, and offers Try again.
- **Dogs say "you".** Dogs and later.dog talk to you by name, never about "the user".
- **Plain words when your Mac is full.** If later.dog can't save part of a chat because the disk is full, you get one calm note instead of errors.
- **Deleting a dog frees its trial computer.**
- **Thinking time starts when work resumes.** Time spent answering a question or approving a step no longer makes your dog look slow. The timer also stays right when you return to a chat.
- **The tour keeps Apps search clear.** Hints fit the available space, including longer translations and smaller windows, and scroll when needed.
- **Recent desktop updates in your language.** The launch updates now have translations in German, Spanish, French, Hindi, Japanese, Brazilian Portuguese, Ukrainian, and Simplified and Traditional Chinese.
- **Clear computer buttons.** Open, wake and show a computer directly, without instructions to find an old picker.

## 0.3.27 — 2026-10-13

- **Your organization's tricks are back in a dog's profile.** The tricks your organization shares are listed there again, and adding one puts it on that dog, switched on.
- **App icons come with later.dog.** Apps no longer fetches icons from Google, so which apps you look at stays on your Mac. An app without an icon shows its first letter.
- **Claude Haiku 5.5 takes an effort level.** It offers the same effort choices as the other 5.5 models, starting at Medium, and later.dog now reports its 1M-token context limit correctly.
- **Dictation keeps your sentences straight.** When Mac dictation pauses and starts listening again, a new sentence that begins like the last one ("Yes", then "Yesterday") stays its own sentence, and a fix to an earlier word ("Their" becoming "They're") replaces the old words instead of repeating them, in languages written with or without spaces.

## 0.3.26 — 2026-10-13

- **Dogs use their computer.** A dog left on Auto works on its cloud computer instead of saying it has none, and it handles a sign-in with a Secure Form or a Take over card rather than refusing.
- **Quiet while it works.** A dog says once what it is about to do, then works without a running commentary. Its screenshots stay with it: you watch the live screen instead of a stream of pictures in chat, and what it said along the way folds into its reply.
- **One card when a dog needs you.** Secure Form and Take over look and behave the same, with hover feedback and a clear status. After you send your details the card says so, and "(retry)" is gone.
- **Your draft stays put.** Each chat keeps what you were typing when you switch to another chat and back.
- **New messages, easier to spot.** The "New" divider sits in the middle of the line, and the jump-down button says how many new messages are waiting below.
- **The account chip shows the provider.** Its logo is front and center with the account's initials as a small badge, and your name no longer appears twice in the sidebar.
- **A usage ring.** The ring around the account fills as you use it and turns from green to yellow, orange and red as it runs low. Click the chip for a small summary of what's left, with Details for the full page.
- **Dictation works.** Mac dictation keeps your earlier words when it pauses to listen again, and voice notes can use your ElevenLabs or xAI key, or the free trial.
- **No repeated models.** The model menu leads with the newest of each model, More models holds the rest without repeats, and older versions sit under Earlier versions. Claude Haiku 5.5 is in the list.
- **Unread until you look.** A reply that finishes while later.dog is in the background stays unread until you come back to it.
- **Hover feedback everywhere,** including Apps, Settings and menus.
- **170 apps.** Apps groups them into 21 categories, with the rest of the categories under More and a View all for each. Sign-in also works with services that hand later.dog a client secret.
- **A tidier Models page.** Models are grouped by account with how many are shown, newest first, with older versions under Earlier versions.
- **Real effort names.** The effort button shows the level the model actually uses, such as High, instead of "Default".
- **Any dog can make a group chat.** Ask a dog for a group chat with teammates and it creates it, then renames it or changes who is in it when you ask. A dog only mentions a Chief of Staff when your team has one, and for a new pack it points you to Create a pack.
- **A pasted conversation ID stays as you pasted it** instead of turning into a link.

## 0.3.25 — 2026-10-13

- **When a step needs you, the dog hands you the screen.** For a sign-in, a code, a CAPTCHA or a payment, the dog does the legwork first, then a Take over card puts you on its computer with one tap. Press Done and it carries on. A sign-in is never a reason for it to stop.
- **Secure Form.** When a dog needs sign-in details, it asks in a sealed card. What you type is never shown in chat; it is only typed into the site the card names.
- **A new dog answers straight away.** You no longer have to pick one of the intro options before it replies.
- **Quiet by default.** Dogs work without posting a line before every step and only write when it matters. Turn on Step-by-step updates in Settings if you like the play-by-play. A "New" divider marks where your unread messages start.
- **The green dot is back** while a dog is thinking or working.
- **Earlier messages stay put.** Messages no longer hide, and thinking no longer pushes the conversation up.
- **Voice notes that hear you, for less.** Sharper dictation now runs on Whisper large-v3-turbo through later.dog. With your own ElevenLabs key it uses Scribe v2. The send button stays visible while you record.
- **The account picker shows who's signed in,** with that account's initials, and changing the model no longer switches the account.
- **One choice per model,** with each provider's own names for its reasoning levels (such as Max, Ultra and Ultracode).
- **Only your accounts.** Lists show the accounts you added, and you can drag them into the order you want, in Settings or at the top of a chat.
- **Add any account.** Besides Claude and ChatGPT, Add account offers the other providers and any OpenAI-compatible service, including OpenRouter.
- **See what's left.** Usage shows "% left" and when it recharges, with a sleeping dog when an account is resting.
- **A simpler dog profile.** The dog's computer lives in its profile, and the dog naps when it's idle. Memory is one "Manage memory" row, and Teach a trick can be closed.
- **Settings → Computer, redone**, to show the dog's computer and its choices at a glance.
- **A shorter profile menu:** Switch profile, Settings and Sign out. Everything else is in Settings.
- **later.dog lives in Applications.** New installs come as a disk image you drag into Applications. If you open later.dog straight from Downloads, it offers to move itself there, where it stays put and keeps itself up to date.

## 0.3.24 — 2026-10-12

- **When you say no, the dog says so.** If you don't allow a step, a Kimi or Grok dog is told you said no: it stops looking for another way in and tells you the step wasn't allowed, instead of blaming missing permissions.

## 0.3.23 — 2026-10-12

- **A card about your Mac says so.** When a Kimi or Grok dog asks to act on your own Mac, the card reads "wants to use this Mac" instead of "use its computer", so it can't be taken for the dog's own cloud computer.

## 0.3.22 — 2026-10-12

- **Messages you send mid-reply get answered.** On Kimi and Grok, something you send while a dog is still writing is answered in the same turn, instead of waiting until you write again.
- **The dog's computer opens its browser straight away.** A new cloud computer no longer stops on a "Choose Preferred Application" window, so web tasks on the free models finish in seconds. (This one is on later.dog's side and is already live for every version.)

## 0.3.21 — 2026-10-12

- **No more garbled replies from the free models.** When Kimi or Grok writes a step out as text instead of doing it, you no longer see that text: the dog is told once to do the step properly, and if it happens again it says so in one plain sentence.

## 0.3.20 — 2026-10-12

- **Plain words when a step didn't work.** If a step of a Kimi or Grok dog's task fails or isn't allowed, the chat says "Some steps didn't work or weren't allowed, so check them before relying on this answer" instead of a technical notice.

## 0.3.19 — 2026-10-12

- **A free dog's first computer task asks nothing.** On Kimi and Grok, an Off-leash dog picks its own cloud computer and gets on with the job, with no "wants to use a computer" card. Choosing your Mac still asks, and Heel still asks for everything.

## 0.3.18 — 2026-10-12

- **Your Mac still asks first.** On Kimi and Grok, Off-leash runs the dog's own computer and browser without a card, but a dog working on your own Mac now asks before each action there, as Heel does. In 0.3.16 and 0.3.17 it didn't once you had let a dog onto your Mac.
- **Plainer words** for routines, connected apps and analytics, and the Mac permission panel can be translated.

## 0.3.17 — 2026-10-12

- **Opening a dog's computer is clean the first time.** It starts once, and no error sits under a screen that came up fine. If the computer is busy starting or changing elsewhere, the panel says so in plain words.
- **Accounts says what an account is for:** adding Claude or ChatGPT lets your dogs use the plan you already have.

## 0.3.16 — 2026-10-12

- **Off-leash means it on the free models.** On Kimi and Grok, a dog that's Off-leash now works on its own computer and browser without stopping for a card at every step. Connected apps still ask first, and Heel still asks for everything.
- **Cloud tasks in plain words.** One card at message width: what the dog is working on, one status (Working, Ready to review, Done, Stopped, Needs you), a thin progress line and one button. Steps fold away; no PR numbers, branches or git terms. When a cloud task can't run here, the dog says so in one sentence and does the work in the chat instead.
- **Open the computer and it turns on.** Opening a dog's computer starts it if it never started and wakes it if it's asleep.
- **A dog that needs your hands says so in the chat**, with Open, not only inside the Computer panel.
- **Approvals say whose computer:** "use its computer" for the dog's own, "use this Mac" for yours.
- **The + menu** offers Heel and Off-leash, like the dog's settings, and its apps entry reads Connect apps.
- **Apps shows what works.** Apps that need a Composio key no longer sit greyed out; one line says a key brings them in. The tour names apps that connect in one click.
- **Free trial for everyone on a network.** Up to three people sharing an office, campus or hotspot can each start the free trial, and when the day's free allowance runs out for everyone, later.dog says so instead of "try again in a minute".
- **Keep going when an account runs out** shows once you have two accounts.
- Everyday words say dog, not agent.

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
