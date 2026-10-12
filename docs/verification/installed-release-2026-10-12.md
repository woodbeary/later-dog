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
| Release assets | v0.3.16 and v0.3.17: the zip matched `SHA256SUMS.txt` and the updater's `latest-mac.yml` sha512. |
| Signature and Gatekeeper | `codesign --verify --deep --strict` passed; `spctl` accepted the copy marked as downloaded (Notarized Developer ID); the ticket was stapled. |
| First run | Name, then a first dog (breed, colour, name), then the chat. The dog greeted the person by name on Kimi K2.6 and asked one question with options; answering it got a reply. The five-step tour ran and ended back in the chat. |
| Composer | `+` (attach, connect apps, Heel or Off-leash), the model button (Kimi K2.6, Grok 4.3), dictation's mic once the dog was idle; no voice-chat button with Voice mode off. |
| Accounts | The header's account menu listed Kimi and Grok with Add account; Add account opened Settings with Claude and ChatGPT (not signed in). Settings, Models listed both free models with a switch each. |
| Cloud computer | Opening a dog's computer started its trial computer and showed the live desktop. Settings, Computer showed the trial's minutes left and the running computer. |
| Ending the trial | `DELETE /v1/trial` answered 200; the copy's folder and its Launch Services registrations were removed, and `laterdog://` links opened the installed app again. |

## Corrected during the run

- **0.3.16:** the first open of a dog's computer showed a red "being changed" error
  under a screen that came up fine: two starts collided. Fixed in 0.3.17 (one start
  at a time, plain words if another start is in progress); the 0.3.17 run showed the
  desktop in about 4 seconds with no error.
- **The check itself:** a launch with only `HOME` changed reads the Mac's real
  later.dog data, because the app finds its folders through Foundation. The script
  above replaced hand launches.

## Not proven by this run

- Claude's browser sign-in finishing by itself, ChatGPT's device code, and either
  account's chat (no account was signed in).
- A dog's own computer use on Kimi or Grok under Off-leash (covered by unit tests).
- Dictation and saved voice notes with a real microphone (no permission prompt was
  answered).
- Cloud tasks against a live supervisor, connected apps' OAuth, and later.dog Cloud
  checkout.
- Updating in place from an older install.
