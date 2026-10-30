# Texts and email on the Mac

On a Cloud home, a dog can read the person's texts in Messages, send a text,
and send an email from Mail, all on the Mac they lend to their Cloud. It needs
the Terminal part of lending, which a Mac signed in to later.dog Cloud lends
with its home folder. Other setups don't get these tools: a later.dog running
on the Mac itself already has that Mac's own terminal.

## The tools

| Tool | Takes | Does |
|---|---|---|
| `send_text` | `to` (a phone number, an email address or a name in Contacts), `text` | Sends through iMessage, or SMS when iMessage refuses and the iPhone forwards texts to the Mac |
| `read_texts` | `with` (a name, number or email), `since` (`2026-10-29` or `2026-10-29 14:30`, the Mac's time zone), `limit` (default 20, at most 50) | Lists texts oldest first, with names from Contacts |
| `send_email` | `to` and `cc` (up to 10 addresses each), `subject`, `body` | Sends plain text from Mail's default account |

A name in `to` is looked up in the Mac's Contacts first, so the card can show
the number or address it will use: the only one, else the only phone number,
else the only mobile one. When that still leaves more than one, nothing is sent
and the dog is told the choices to ask about.

Each takes `computer_id` when more than one Mac is lent. `read_texts` skips
reactions and conversation events, shows a text that is only a photo or file
as `(attachment)`, and says who a text went to (`to`) and the number or
address to answer (`handle`).

## Asking first

A text or an email asks every time. The card names the Mac and shows the
recipients, the subject and every word, with **Send** and **Don't send** on the
desktop and the iPhone. Whatever the Mac is set to, Always included, nothing
is sent without that answer: an earlier yes is never reused, the card has no
Always allow, switching the Mac to Always doesn't answer a waiting card, and
**Don't send** refuses only that one message. On a Mac set to Never nothing
runs at all, not even a Contacts lookup, and there is no card. Every refusal
that stops a send starts with "Nothing was sent." The chat engines don't add their own approval in front of
these two tools, so the card is the one ask.

Reading texts follows the Mac's setting like looking at its files: Always reads
at once, Ask shows a card ("read your texts on your Mac", with whom and since
when), Never refuses.

## How it runs on the Mac

Everything runs through the Mac's command runner, so any later.dog that lends
Terminal can do it.

- **Sending.** The command is fixed: `bash` reads NUL-separated fields from its
  input and hands them to `osascript` as arguments. The recipients, subject and
  words travel as the command's input, never as part of the command line.
- **Reading.** `/usr/bin/sqlite3 -readonly -json` on
  `~/Library/Messages/chat.db`, with only checked values in the query: dates by
  pattern, numbers as digits, addresses by pattern. Names come from the
  Contacts databases under `~/Library/Application Support/AddressBook`, asked
  only for the people in the result or the name the dog gave.
- **Rich bodies.** macOS now keeps most texts' words only in the message's rich
  body. later.dog reads them from there (on 400 recent real messages, 379 had
  no plain text and all 379 were read; the 21 that had both matched exactly).
- **Waiting.** A send waits up to 100 seconds, long enough for the person to
  answer macOS's first "control Messages" or "control Mail" prompt, then stops
  the command and tells the dog to have the person check before trying again.

## What macOS asks the person

macOS asks about the program that lends the Mac. In the later.dog app that is
later.dog. In later.dog Dev it is `node`, which runs Dev's Mac connection
(`scripts/dev-mac.mjs`), so a grant to it reaches every script that node runs.
Every Mac command first prints which program it runs under
(`ps -o comm= -p $PPID`), and the dog's instructions name that program, with
its path when it is `node`.

- The first text asks whether that program may control Messages, and the first
  email whether it may control Mail. If it was refused, the dog says where to
  turn it on: System Settings → Privacy & Security → Automation.
- Reading texts needs Full Disk Access for that program: System Settings →
  Privacy & Security → Full Disk Access (for `node`: +, Command-Shift-G, its
  path). It takes effect once the program restarts: quit and reopen later.dog,
  or later.dog Dev → Restart later.dog Dev. Names from Contacts come with it.
- SMS needs Text Message Forwarding for this Mac on the iPhone. Mail needs an
  account to send from.

## Limits

- Delivery isn't confirmed: the dog says the text was handed to Messages.
- A model can still say it sent something it never sent. In live runs with
  Grok this happened twice: once a dog answered "Sent" without calling the
  tool, in a conversation where it had already claimed a refused text went
  through; once it said "Texting Sam now." and stopped. Nothing was sent
  either time, and nothing can be without the card, so the card is the record
  of what was sent.
- No attachments, no new group texts, no reading email, and Mail always sends
  from its default account.

Code: `server/laterdog/mac-messages.ts`, `server/routes/mac-messages.ts`, the
send and read kinds in `server/mac-approval.ts`, the tools in
`server/drivers/agents-catalog.ts`. Tests: `server/laterdog/mac-messages.test.ts`
runs the real shell hand-off and real `sqlite3` queries against throwaway
Messages and Contacts databases; `server/mac-approval.test.ts` covers the cards.
