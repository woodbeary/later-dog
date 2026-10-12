# Using later.dog

later.dog is a free, open-source Mac app where AI agents, which we call dogs, do real work for you. Each dog is a
contact in your sidebar with its own conversation, memory and computer. You start free on the Kimi K2.6 and Grok 4.3
models with no account, and bring the Claude or ChatGPT plan you already have whenever you like. There are no API keys
to paste.

## Install

You need a Mac with Apple silicon.

1. Download `later.dog-macOS-arm64.zip` from the [latest release](https://github.com/woodbeary/later-dog/releases/latest).
2. Unzip it and drag **later.dog** into Applications.
3. Open **later.dog**. It is signed with an Apple Developer ID and notarized by Apple, so macOS only asks once whether
   to open an app you downloaded from the internet.

## First run

The welcome asks your name and lets you pick your first dog. It says hello right away on the free Kimi K2.6 model. The
free trial lasts 7 days: chatting on Kimi K2.6 and Grok 4.3 (with a daily allowance), a voice, and a cloud computer for
30 minutes, with no account and no card.

## Make a dog

Choose **New dog**, give it a name and say what it should help with. Send a message to start working. Its look,
instructions, tricks and memory are in its profile: click its name at the top of the chat.

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
have it). **Settings → Models** chooses which models show there. Each account shows its usage, and **Resting until** a
time when it has hit its limit.

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
