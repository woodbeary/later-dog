# Show HN draft

Draft for Jacob's OK. Not posted. Facts come from README.md, CHANGELOG.md, docs/laterdog/ and the site. Lines marked CHECK are not in the repo and need Jacob to confirm.

## Title options

1. Show HN: later.dog, AI helpers on your Mac that keep working for you (open source)
2. Show HN: later.dog, open-source Mac app where AI "dogs" do real work for you

## Body

Hi HN. I'm Jacob. I built later.dog, a Mac app where AI helpers keep working for you. I call them dogs.

Each dog shows up in your sidebar like a contact. It has its own files and its own chat. Dogs can message each other, run on a schedule, use their own computer, and hand coding jobs to the cloud. A cloud job opens a draft pull request. It never merges anything.

It runs on the plans you already pay for. You sign in to Claude or ChatGPT in your browser, so there are no API keys to paste. Before you sign in, your first dog chats on free models (Kimi K2.6 and Grok 4.3) with no account.

What is free:

- The Mac app. It is open source (Apache-2.0).
- Dogs, group chats, routines and skills.
- A cloud computer for 30 minutes, to use within 7 days, no account and no card.
- Cloud tasks, if you deploy the supervisor to your own Cloudflare account. The steps are in the repo.

What costs money: later.dog Cloud, at $10 a month. It gives you cloud computers and cloud tasks with nothing to set up. It is not on sale yet. The README says "coming soon" and so do I. It does not resell AI. Your dogs still think with your own Claude or ChatGPT plan.

There is an iPhone app. It is in TestFlight beta review now, so there is no public link yet. CHECK: say whether the beta will have a public TestFlight link, and when.

Honest limits:

- Mac only, Apple silicon, macOS 12 or later.
- The token battery (it moves a chat to your next account when one runs out) switched live between two real Claude accounts. ChatGPT accounts at a real limit are only tested with fake CLIs.
- Connected apps like Gmail and Slack need a broker you host yourself.
- Voice dictation needs a signed build.
- Passing fixture tests does not prove a live provider works. The repo says what is proven and what is not.

Code: https://github.com/woodbeary/later-dog
Site: https://later.dog

I'm a solo founder, and I'm open to roles. If you like what you see, my GitHub is github.com/woodbeary.

I would like to hear what breaks.

## Before posting

- Show HN wants something people can try. Download link: https://github.com/woodbeary/later-dog/releases/latest
- Confirm the current release is 0.3.28 and that the $10 plan is still "coming soon".
- docs/ios-companion.md still says there is no phone app or paid plan. It is out of date next to the launch. See the notes README.
