# Installed release verification — 2026-10-12

## Scope

The released macOS builds, downloaded from GitHub the way a new user gets them, on
an Apple-silicon Mac (macOS 26.3). Each run used `scripts/sealed-installed-app.sh`:
a temporary home, `CFFIXED_USER_HOME`, and a sandbox that cannot read or write the
Mac's own later.dog data or sign-in stores (checked after every run: no file there
changed). The app was driven over its devtools port. The free trial was a real one
on production `cloud.later.dog`, granted to the copy with the service owner's key and
ended when the run stopped. No Claude or ChatGPT account was signed in.

## Observed results

| Check | Result |
| --- | --- |
| Release assets | v0.3.16 to v0.3.22: the zip matched `SHA256SUMS.txt` and the updater's `latest-mac.yml` sha512. |
| Signature and Gatekeeper | `codesign --verify --deep --strict` passed; `spctl` accepted the copy marked as downloaded (Notarized Developer ID); the ticket was stapled. |
| First run | Name, then a first dog (breed, colour, name), then the chat. The dog greeted the person by name on Kimi K2.6 and asked one question with options; answering it got a reply. The five-step tour ran and ended back in the chat. |
| Composer | `+` (attach, connect apps, Heel or Off-leash), the model button (Kimi K2.6, Grok 4.3), dictation's mic once the dog was idle; no voice-chat button with Voice mode off. |
| Accounts | The header's account menu listed Kimi and Grok with Add account; Add account opened Settings with Claude and ChatGPT (not signed in). Settings, Models listed both free models with a switch each. |
| Cloud computer | Opening a dog's computer started its trial computer and showed the live desktop. Settings, Computer showed the trial's minutes left and the running computer. |
| Off-leash on the free model (0.3.18) | Asked "Open the web browser on your computer, go to later.dog, and tell me the page's headline", the Kimi dog opened Chromium on its own cloud computer, read the page and answered with its real headline and a screenshot in about 14 seconds. Its computer and browser steps showed no card. One card did: the dog first chose its own cloud computer (`select_computer`), which asked "wants to use a computer". |
| Off-leash on the free model (0.3.19) | The same request showed no card at all. The dog took 2 min 36 s this time (it opened a file manager and a default-browser dialog before Chromium) and answered with the right headline; because one of its steps had failed, the chat added a technical notice ("tool operations failed … not an execution receipt"). |
| Off-leash on the free model (0.3.20) | No card again, but the answer was the model's tool call written out as text ("End turn: status: success … stop_reason: tool_pending checkpoint: { "blocks": … }"): nothing had run, and the chat showed it as the reply. |
| Off-leash on the free model (0.3.21) | No card, no notice and no leaked text: the dog opened Chromium on its own cloud computer, read later.dog and answered with its headline, subtitle and a screenshot (2 min 55 s). The copy ran with a dead supervisor address and started normally. |
| A new user's own trial (0.3.21) | Without an owner grant the copy claimed its own free trial from `cloud.later.dog` within seconds, as a stranger's install does, and Kimi answered the first message in about 6 s. The six processes of the app used about 645 MB together. |
| A message sent mid-reply (0.3.21) | The second message showed as "sent mid-turn", but the turn ended with the first reply and the message stayed unread until the next one. |
| A message sent mid-reply (0.3.22) | "Make the dog a corgi named Waffles.", sent while Kimi wrote a story, got its own answer in the same turn: the story again with Waffles the corgi. |
| Grok 4.3 on its own computer (0.3.21) | Same request as above, no card, but Grok stopped on the desktop's "Choose Preferred Application" window after 16 s. After the computers Worker change below, the same request on a fresh computer answered with the headline in 18 s, no card and no window. |
| Ending the trial | `DELETE /v1/trial` answered 200; the copy's folder and its Launch Services registrations were removed, and `laterdog://` links opened the installed app again. |

## Corrected during the run

- **0.3.16:** the first open of a dog's computer showed a red "being changed" error
  under a screen that came up fine: two starts collided. Fixed in 0.3.17 (one start
  at a time, plain words if another start is in progress); the 0.3.17 run showed the
  desktop in about 4 seconds with no error.
- **0.3.18:** choosing the dog's own cloud computer raised the only card of that task.
  0.3.19 treats listing the choices as a read and its own cloud computer as its own;
  `auto` and `local`, which can land on the person's Mac, still ask.
- **0.3.19:** that notice is now in plain words (0.3.20): "Some steps didn't work or
  weren't allowed, so check them before relying on this answer." The rule behind it
  stays: a failed or refused step ends the turn.
- **0.3.20:** such a reply is now withheld (0.3.21): the dog is nudged once to make the
  call, and a second time the turn ends with one plain sentence. The copy also gets a
  dead supervisor address, after one found another fixture's supervisor on port 9010.
- **0.3.21, the computer:** the desktop's Web Browser launcher reads XFCE's helpers.rc, which
  the image never set; the computers Worker now writes it (Chromium) when a boot becomes ready.
  Live for every app version.
- **0.3.21, mid-reply messages:** words still parked when a reply settles now get one more
  round in the same turn (0.3.22).
- **The check itself:** a launch with only `HOME` changed reads the Mac's real
  later.dog data, because the app finds its folders through Foundation. The script
  above replaced hand launches.

## Not proven by this run

- Claude's browser sign-in finishing by itself, ChatGPT's device code, and either
  account's chat (no account was signed in).
- Dictation and saved voice notes with a real microphone (no permission prompt was
  answered).
- Cloud tasks against a live supervisor, connected apps' OAuth, and later.dog Cloud
  checkout.
- Updating in place from an older install.
