# Using later.dog

later.dog is a free, open-source Mac app where AI agents, which we call dogs, do real work for you. Each dog is a
contact in your sidebar with its own conversation and files. You sign in with the Claude or ChatGPT plan you already
have, so there are no API keys to paste.

## Install

You need a Mac with Apple silicon.

1. Download `later.dog-macOS-arm64.zip` from the [latest release](https://github.com/woodbeary/later-dog/releases/latest).
2. Unzip it and drag **later.dog** into Applications.
3. Open **later.dog** once. macOS will say it cannot verify the app, because later.dog is signed with its own
   certificate and not Apple's. Close that message, then open **System Settings → Privacy & Security**, scroll down to
   the message about later.dog and click **Open Anyway**. Confirm, and the app opens. On macOS 15 and later,
   right-click → Open does not work for this, so use Open Anyway. You only do this once.

## First run

The welcome tour asks your name, shows which AI providers it found on your Mac, and lets you sign in. When you finish,
it makes your first dog and the dog says hello.

## Make a dog

Choose **New dog**, then a name, a breed and a color, and a starting role such as chief of staff, engineer or
reviewer. Pick the provider you signed in with. Send a message to start working.

Keep a dog on **Heel** and it checks with you before it runs commands or changes files. Let it go **Off-leash** and it
acts first, then tells you.

## Cloud tasks

A dog can hand a coding job to its own temporary cloud computer (later.dog Cloud, on your own Cloudflare account). The
work runs there, not on your Mac, so your Mac stays free and several tasks can run at the same time.

To start one, ask a dog in plain words, for example "do this in the cloud" or "split this into cloud tasks and run them
in parallel".

A Cloud task card appears in the chat that started it. It shows the task's live status (Setting up, Working, Ready for
review or Needs attention) and what it is doing right now. Click the card to open the task beside the chat. There you can
see its progress step by step, its plan and the files it changed. **Watch screen** shows its live screen while it runs,
**Stop** ends it, and **Open draft PR** opens the result. The dog's Computer panel lists its cloud tasks too.

The result goes to a draft pull request on GitHub. Merging stays with you.

A cloud task needs later.dog Cloud set up on your Cloudflare account, and a GitHub repository its GitHub login can read.
The repository needs no setup: the first task connects it, starts from its default branch and installs its dependencies
itself.

## Add a Claude or ChatGPT account

Go to **Settings → General → Accounts** and choose **Add account**.

- **ChatGPT** shows a web address and a code. Open the address in your browser, enter the code and approve.
- **Claude** opens your browser to approve the sign-in and gives you a code to paste back into later.dog.

The codes expire after a few minutes. If one does, start the sign-in again. later.dog never asks for your password.

## Switch accounts

You can add several Claude accounts and several ChatGPT accounts. Pick the one a dog or a conversation uses from the
model picker. Each account shows its usage, and **Resting until** a time when it has hit its limit.

## Usage limits

Your plan's usage limits are set by Claude or ChatGPT, not by later.dog. When an account runs out, the conversation says
so. To keep going automatically, sign in to more than one account of the same kind and switch on **Keep going when an
account runs out**. later.dog then continues the conversation on your next account and returns to the first one once its
limit resets. If every account is out, it waits and picks up where it stopped. Whether rotating accounts is allowed
under your plans is your decision to make; check each provider's terms. The details are in
[token-battery.md](token-battery.md).

## Updates

later.dog checks GitHub for new releases and downloads them in the background. When one is ready, a small icon appears
at the top of the sidebar. Click it to see what's new and choose **Restart to update**.

## Cloud computers

A dog's Computer panel offers **Try a cloud computer free**, and so does Settings, Computer: 30 minutes on a later.dog
cloud computer, to use within 7 days, with no account and no card. A quick check in your browser starts it, and Settings,
Computer shows the minutes left. When the trial ends, its computer and the files on it are deleted. To keep cloud
computers after that, deploy the computers service to your own Cloudflare account
([deploy/laterdog/computers](../../deploy/laterdog/computers/README.md)). A later.dog Cloud plan is coming soon.

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
