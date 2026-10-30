# Drafts in replies

Start the isolated fake-engine server:

```sh
node --experimental-strip-types scripts/verify-drafts.ts
```

It prints the fixture's `url`. Point a renderer at it:

```sh
LATERDOG_DEV_API_URL=<url> pnpm exec vite --host 127.0.0.1 --port 5296 --strictPort
```

Open the app, skip the tour, and open the dog named **Drafts**. Its chat has two
persisted replies: an email draft, then the same draft revised (same `id`) next
to a draft post for X. Ctrl-C closes the fixture and removes its data.

## What to check

- Each `draft` block draws as a card titled by where it goes ("Draft email to
  sam@example.com", "Draft post for X"), with its subject and text.
- The revised email offers **Show changes**: added words are highlighted and
  bold, removed words struck through. The first version and the X post don't
  offer it.
- **Edit** turns the text into a box. **Send** puts "Send this draft:" (or "Send
  this draft as I edited it:") and the draft block into the chat as the
  person's message, and the card then says it asked the dog to send it. The
  dog does the sending with its own tools, so the usual approval still
  applies.
- **Copy** copies the current text.
