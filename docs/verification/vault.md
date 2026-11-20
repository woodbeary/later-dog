# Saved logins (vault)

Start the isolated fixture. It runs a stand-in cloud computer, gives the server a
random test vault key, saves two logins (example.com and paypal.com), and has the
dog **Signer** ask for two sign-ins: one on accounts.example.com in its first
task, one on paypa1.com in a second task.

```sh
node --experimental-strip-types scripts/verify-vault.ts
```

It prints the fixture's `url`, the dog and both tasks, and a `continueFile`. Point a
renderer at the url:

```sh
LATERDOG_DEV_API_URL=<url> pnpm exec vite --host 127.0.0.1 --port 5294 --strictPort
```

## What to check

- **Settings → Vault** lists both logins with their usernames, and adds, edits and
  removes one. An address such as `https://github.com/login` is saved as
  `github.com`.
- Signer's Secure Form for accounts.example.com opens on one row per saved account,
  kit@example.com, which signs in when clicked, and a **Use a different login** link
  that shows the fields with **Save to your vault once it works** ticked under them.
  Nothing on it offers to let Signer use the login without asking.
- Click the kit@example.com row. The card then reads **Saved login ·
  kit@example.com** and **Typing it in**.
- Switch Signer to the second task (`POST /api/bots/<dog>/tasks/<task>`). Its form
  for paypa1.com warns that the site is not paypal.com, offers no saved login and
  no Save box.
- Create the `continueFile`. The fixture starts a third task in which Signer asks
  again for accounts.example.com, and writes `vault-checks.json` in its data
  folder: the form comes back already filled, the password is in no tool answer
  and no plain command, and `vault.json` holds no plain text.

## What it does not cover

The stand-in cloud computer cannot take the fake engine's screenshot, so the dog's
turns end early and `fill_secure_field` is not run here. Typing is covered by the
unit tests in `server/cloud-computer-tools.test.ts` and
`server/laterdog/secure-form.test.ts`: the value travels only as base64 in the
command and never comes back in the answer. A real cloud computer and a real
Cloud home's key are only exercised on a live home.

Ctrl-C closes the fixture and removes its data.

## Saved details at a checkout

```sh
node --experimental-strip-types scripts/verify-vault-details.ts
```

It runs on its own and exits. It saves a name, email, street and ZIP as the
person's details, has the dog **Shopper** ask for a checkout form on
shop.example.com (first and last name, email, phone, street, an optional apartment,
ZIP, each tagged with its autocomplete name), fills the card from the details as
**Use my details** does, types a phone, leaves the apartment empty and presses
Continue with **Save these to my details**. It prints `ok: true` when the card kept
every tag, the details filled first and last name, email, street and ZIP, the form
was sent and saved, the empty apartment was marked as nothing to type, the dog was
woken to type the rest and told to leave the apartment as it is, no value reached
the dog, the typed phone was added to the details, and `vault.json` holds no plain
text. Typing itself is left to the unit tests, as above.

## Saving a login only once it works

```sh
node --experimental-strip-types scripts/verify-vault-saves.ts [evidence.json]
```

It runs on its own and exits, writing what it saw to `evidence.json` when you name
one. The dog **Signer** asks to sign in on accounts.example.com with a stand-in
cloud computer. Driving the dog's own computer tools over MCP and the person's side
over the home's routes, it checks three things:

- **A wrong password.** The person types kit.fixture@example.com with a wrong
  password and leaves saving on. Signer types both fields and reports
  `secure_form_result` rejected with the site's words. The vault holds nothing for
  example.com, and the same card is open again with the email kept, the site's
  words, saving still asked for, and nothing typed in its fields.
- **The corrected password.** The person sends the right password from that card.
  Signer types it and reports signed_in. The vault now holds exactly one login for
  example.com, marked as having signed in, and the card reads signed in and saved.
- **The same account in other letters.** Signer asks again; the person types
  Kit.Fixture@Example.COM with a new password. After signed_in the vault still holds
  one login for example.com, the same entry rewritten with the new spelling, and the
  sheet's offers show it once. Signing in once more with that saved login marks it
  as having worked again.

It prints `ok: true` only when all of that holds, no password appears in a plain
command, a tool answer or `vault.json`, and the email is not in `vault.json` either.

What it does not cover: the stand-in cloud computer does not start here, so
`fill_secure_field` answers that the computer did not start and types nothing;
`notExercised` in the output says so. Typing is covered by the unit tests named
above. The site's answer comes from the dog: the fixture cannot show a real page, so
it proves what later.dog does with the dog's report, not that a real dog reads the
page right.
