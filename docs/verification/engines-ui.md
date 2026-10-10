# Engine setup preview: onboarding and accounts

Use the actual renderer with sample engine statuses and a disposable server:

```sh
node --experimental-strip-types scripts/verify-engines-ui.ts
```

Open its printed `previewUrl`. The bottom toolbar switches between the real
Settings modal, which opens on General with its Accounts list, and onboarding,
applies the app's Midnight/Atelier skins, and toggles a synthetic Antigravity
connection. **Onboarding preview** opens the welcome flow directly at the
engines beat. Provider install, sign-in and account-management requests are
rejected by fixture-only middleware; no real provider login or user
configuration is involved. A rejected request is useful for checking error
presentation, not evidence that provider auth works.
**Toggle sample ChatGPT plan** changes only the synthetic account state; it
does not sign in or contact OpenAI.
Vite's generated source cache stays in the checkout's ignored
`.laterdog-scratch/engine-preview-vite` directory; fixture accounts, home, and app data
remain disposable. Keeping these separate prevents late cache writes from
recreating a removed fixture directory.

Settings has no Engines page, so this preview no longer shows engine cards,
CLI paths, provider icons or server installs; onboarding's engines beat is the
remaining engine list.

## Checks

1. Onboarding lists Claude, Codex and Cursor with status pills, then the other
   engines that already work (Grok and OpenCode); the rest are named once under
   **Coming soon**. Rows that need setup start collapsed. Provider marks keep
   the selected skin's colors. At 390px there is no horizontal page overflow
   and **Continue** stays reachable while the list scrolls.
2. Toggle the sample connection. Antigravity moves from **Coming soon** into
   the list as Ready without reopening onboarding or changing focus.
3. Expand Cursor. Its setup opens inline under the row with this platform's
   install command.
4. Open **Settings preview**. Settings → General → Accounts lists Claude
   (`personal@example.test`), Codex (`work@example.test`) and ChatGPT plan,
   which reads **Not signed in** and offers **Sign in**. Toggle the sample
   ChatGPT plan: its row shows `preview@example.test`. **Sign out** asks for
   confirmation, and the fixture's refusal appears under the row with
   **Sign out** usable again. Check Midnight and Atelier; no horizontal
   overflow.

Automated coverage:

```sh
pnpm exec vitest run scripts/verify-engines-ui.test.mjs
pnpm exec vitest run src/components/EngineLibrary.test.ts src/components/EngineSetup.test.ts src/components/onboarding/beats/EnginesBeat.test.ts src/lib/onboarding.test.ts src/components/AccountsPanel.test.ts src/components/ClaudeSignIn.test.ts src/components/DeviceSignIn.test.ts src/components/GrokSignIn.interaction.test.ts src/components/EngineSetup.grok.test.ts src/components/EngineUpdateNotice.test.ts src/components/ModelPicker.test.ts
pnpm typecheck
pnpm i18n:check
pnpm build
```

Interrupt the foreground launcher to stop only its owned child and remove its
temporary data. Keep the printed server log as evidence. Restore any temporary
browser viewport override after responsive checks. This recipe does not prove
real provider installations or sign-ins; use the separate
[offline server sign-in recipe](server-settings.md) for the real auth boundary.

Stopping during unfinished Vite dependency transforms can still report exit 13
from `ui.close()`. The app server and its disposable data are cleaned first;
verify those outcomes rather than treating that development-tool exit code as
an installed-app failure. Ready preview shutdown exits 0; startup cancellation
reports the launch-cancelled error.
