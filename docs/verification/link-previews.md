# Link previews

Start the isolated fake-engine server:

```sh
node --experimental-strip-types scripts/verify-link-previews.ts
```

It prints the fixture's `url`. Point a renderer at it:

```sh
LATERDOG_DEV_API_URL=<url> pnpm exec vite --host 127.0.0.1 --port 5296 --strictPort
```

Open the app, skip the tour, and open the dog named **Links**. Its persisted
reply links later.dog, Wikipedia and a picture. Ctrl-C closes the fixture.

## What to check

- The reply ends with a card for each of the first two pages it links: the
  site, the page's title, its description and its picture when it has one.
  Clicking a card opens the page.
- The picture link gets no card, and neither do links inside code.
- The fixture's server fetches the pages itself through `GET /api/link-preview`,
  so this needs a network. It reads only `https` pages on public addresses: a
  name that resolves to a private or local address is never contacted, and each
  redirect is checked again (`server/laterdog/link-preview.test.ts`).
