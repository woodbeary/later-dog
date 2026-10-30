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
- Signer's Secure Form for accounts.example.com shows **Saved in your vault** with
  kit@example.com and a **Use** button, a **Let Signer use it on example.com without
  asking** box, and **Save this login to your vault** under the fields.
- Tick the box and press **Use**. The card then reads **Saved login ·
  kit@example.com** and **Filling in**, and Signer's **Allowed without asking** list
  shows **Sign in to example.com with your saved login**.
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
