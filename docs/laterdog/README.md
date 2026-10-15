# Using later.dog

later.dog is a free, open-source Mac app where AI agents, which we call dogs, do real work for you. Each dog is a
contact in your sidebar with its own conversation, memory and computer. You start free on Claude Sonnet 5, Grok 4.7
and Grok 4.6 with no account, and bring the Claude or ChatGPT plan you already have whenever you like. There are no API
keys to paste.

## Install

You need a Mac with Apple silicon.

1. Download `later.dog-macOS-arm64.dmg` from the [latest release](https://github.com/woodbeary/later-dog/releases/latest).
2. Open it and drag **later.dog** onto the Applications folder.
3. Open **later.dog** from Applications. It is signed with an Apple Developer ID and notarized by Apple, so macOS only
   asks once whether to open an app you downloaded from the internet.

If you open later.dog straight from the disk image, it offers to move itself into Applications, where it stays put and
keeps itself up to date.

## First run

The welcome asks your name and lets you pick your first dog. It says hello right away on the free Claude Sonnet 5. The
free trial lasts 7 days: chatting on Claude Sonnet 5, Grok 4.7 and Grok 4.6 (with a daily allowance), a voice, sharper
dictation, and a cloud computer for 30 minutes, with no account and no card. When a day's free Claude or Grok
messages run out, the chat carries on with Kimi K2.6 until the next day. How the free models work, their limits and
their costs: [included-ai.md](included-ai.md).

## Make a dog

Choose **New dog**, give it a name and say what it should help with. Send a message to start working. Its look,
instructions, tricks and memory are in its profile: click its name at the top of the chat. Click the picture there to
switch between the dog, a picture you upload, or one generated for it (when picture generation is set up), and click the
name or **Add a label** under it to change them. The profile's **Computer** tab shows the dog's own computer: its screen
when it is awake, or a sleeping dog with **Wake** when it is not.

Keep a dog on **Heel** and it checks with you before it runs commands or changes files. Let it go **Off-leash** and it
acts first, then tells you. Choose with the **+** beside the message field, where you also attach files and connect
apps.

## Cloud tasks

A dog can hand a coding job to its own temporary cloud computer (later.dog Cloud, on your own Cloudflare account). The
work runs there, not on your Mac, so your Mac stays free and several tasks can run at the same time.

To start one, ask a dog in plain words, for example "do this in the cloud" or "split this into cloud tasks and run them
in parallel".

A card appears in the chat that started it. It says what the dog is working on, gives one plain status (Working, Ready to
review, Done, Stopped or Needs you) and has one button. **Open** shows the task beside the chat: its steps, its plan and
the files it changed, with **Watch screen** to see its live screen and **Stop** to end it while it runs. Once there is
something to look at, the button becomes **Review changes**. **Steps** on the card lists what the task did, in plain
words. When the task finishes, the card settles and the dog carries on in the chat. The dog's Computer panel lists its
cloud tasks too.

The result goes to GitHub as a draft for you to review: the dog publishes it, or you can press **Publish** beside the
chat. Merging stays with you.

A cloud task needs later.dog Cloud set up on your Cloudflare account, and a GitHub repository its GitHub login can read.
The repository needs no setup: the first task connects it, starts from its default branch and installs its dependencies
itself.

## Add a Claude or ChatGPT account

Go to **Settings → General → Accounts** and choose **Add account**.

- **Claude** opens your browser. Approve the sign-in there and later.dog finishes by itself. If your browser is on
  another device, choose **Use a code instead** and paste the code it shows.
- **ChatGPT** shows a web address and a code. Open the address in your browser, enter the code and approve.

You can also just pick Claude or ChatGPT for a chat and send a message: later.dog asks you to sign in first, then sends
it. Codes expire after a few minutes; if one does, start the sign-in again. later.dog never asks for your password.

## Switch accounts

You can add several Claude accounts and several ChatGPT accounts, and name each one. The button at the top of a chat
picks the account; beside the message field you pick the model and how hard it thinks (and **Fast mode** on models that
have it). **Settings → Models** chooses which models show there. Each account shows how much it has left, as a ring or
bar that drains as you use it. An account that has hit its limit sleeps, with a line that recharges until it is **Back
at** a time (**Back around** when the provider did not say when the limit resets).

## Usage limits

Your plan's usage limits are set by Claude or ChatGPT, not by later.dog. When an account runs out, the conversation says
so. To keep going automatically, sign in to more than one account of the same kind and switch on **Keep going when an
account runs out**. later.dog then continues the conversation on your next account and returns to the first one once its
limit resets. If every account is out, it waits and picks up where it stopped. Whether rotating accounts is allowed
under your plans is your decision to make; check each provider's terms. The details are in
[token-battery.md](token-battery.md).

## Updates

later.dog checks GitHub for new releases and downloads them in the background. When one is ready, a small icon appears
at the bottom of the sidebar. Click it to see what's new and choose **Restart to update**.

## Cloud computers

Every dog has its own computer. Open it with the screen button at the top of a chat: it starts (or wakes) and you see
its screen. The free trial includes one cloud computer for 30 minutes, to use within 7 days, and Settings, Computer shows
the minutes left. If another dog already has the trial's computer, later.dog offers later.dog Cloud ($10 a month), which
gives every dog its own. When the trial ends, its computer and the files on it are deleted. You can also deploy the
computers service to your own Cloudflare account ([deploy/laterdog/computers](../../deploy/laterdog/computers/README.md)).

Settings, Computer lists every cloud computer with the dog it belongs to (asleep when its computer is). **Sleep** puts an
awake one to sleep now instead of waiting for it to idle; **Delete** removes it and its files, after you confirm. Both
wait while a dog is using that computer. The same page names your own computer and, under **Execution on this
computer**, lets you set each dog to Heel or Off-leash, the same setting as in the dog's profile.

When a dog needs to sign in to a site on its cloud computer, it opens the sign-in page and asks you in the chat with a
**Secure Form**. Click **Open**, fill in what it asks for and choose **Continue**. later.dog types each value straight
into that site's page: the dog never sees them, they never appear in the chat, and they are only typed into the site the
form names. later.dog keeps them in memory, never on disk, and forgets them two minutes after the last one is typed, or
ten minutes after you send them. For a CAPTCHA, a passkey or a payment, the dog hands you its screen instead. Fill
Secure Forms in the desktop app; the phone shows that one is waiting.

## Get help

- Look through the [open issues](https://github.com/woodbeary/later-dog/issues), and open a new one if your problem is
  not there. Say which version you run (Settings, About) and what you did.
- Never paste a password, a sign-in code or a token into an issue.

## Report a security problem

Please do not open a public issue. Use the
[private vulnerability report](https://github.com/woodbeary/later-dog/security/advisories/new); only you and the
maintainers can see it until a fix is out. [SECURITY.md](../../SECURITY.md) has the details.

## Support later.dog

later.dog is free and stays free. See [support.md](support.md) if you want to help keep it going.
