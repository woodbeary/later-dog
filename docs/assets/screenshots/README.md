# Screenshots

Screenshots of the current app for the README and the website. Each one comes from an isolated fixture with seeded
dogs, never from a real home or a person's data.

| File | Shows |
| --- | --- |
| `desktop.webp` | The Mac app: the main dog's badge, the pinned grid, sections and one chat |
| `iphone.webp` | The same workspace on the iPhone |
| `computer.webp` | A dog's computer awake in its Computer tab |

None are checked in yet. When they are, the README's Screenshots section shows `desktop.webp` and `iphone.webp`.

## Taking them

1. `node --experimental-strip-types scripts/control-laterdog.ts ui launch --mode happy` starts a disposable
   fake-engine server and the real renderer, and prints a handle with `url` and `previewUrl`.
2. Seed dogs with `pnpm control:laterdog new-bot --name NAME --url URL`, pick the main dog with
   `PATCH /api/main-dog`, and send a message with `pnpm control:laterdog send`.
3. Open `previewUrl` at 1440×900 with device scale 2, plus a 390×844 crop, in the dark skin.
4. Encode with `cwebp -q 82`.
5. Look at every image at 390 px and 1440 px wide before it goes in.

The fake engine's canned replies ("hello from fake claude") and the fixture's own dogs must not show in a published
image: seed real-looking replies or crop them out.
