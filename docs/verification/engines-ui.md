# Engine setup preview: onboarding and accounts

Use the actual renderer with sample engine statuses and a disposable server:

```sh
node --experimental-strip-types scripts/verify-engines-ui.ts
```

Open its printed `previewUrl`. The bottom toolbar switches between the real
Settings modal, which opens on General with its AI accounts list, and the
welcome flow, applies the app's light and dark looks, and toggles a synthetic
connection and a sample ChatGPT plan. Provider install, sign-in and
account-management requests are rejected by fixture-only middleware; no real
provider login or user configuration is involved. A rejected request is useful
for checking error presentation, not evidence that provider auth works.
**Toggle sample ChatGPT plan** changes only the synthetic account state; it
does not sign in or contact OpenAI.
Vite's generated source cache stays in the checkout's ignored
`.laterdog-scratch/engine-preview-vite` directory; fixture accounts, home, and app data
remain disposable. Keeping these separate prevents late cache writes from
recreating a removed fixture directory.

Settings has no Engines page and the welcome flow has no engine step: it is
**Welcome to later.dog** (your name) and then **Meet your first dog**. AI
accounts are added from Settings or when a dog first needs one.

## Checks

1. **Onboarding preview** opens **Welcome to later.dog** with a name field,
   **Continue** and **Maybe later**; the next step is **Meet your first dog**
   (breed, color, name, **Start chatting**, **Back**). No engine list appears.
2. Open **Settings preview**. Settings → General → AI accounts lists Claude
   (`personal@example.test`), Codex (`work@example.test`) and Grok
   (Signed in), with **Add account** and the **Keep going when an account runs
   out** switch. The sections are General, Computer, Usage & Billing and
   Updates.
3. Toggle the sample ChatGPT plan: a **ChatGPT plan** row appears with
   `preview@example.test`. Its remove button asks **Remove ChatGPT plan?**
   with Cancel and Remove; confirming shows the fixture's refusal ("Preview
   only, no real account or installation is changed.") under the row, which
   stays usable. Check light and dark; no horizontal overflow.

Steps 1 to 3 were walked on 2026-10-18 against `finalize/integration`, in the
dark look at desktop width only; the screenshots are outside the repository.

Automated coverage:

```sh
pnpm exec vitest run scripts/verify-engines-ui.test.mjs
pnpm exec vitest run src/components/EngineLibrary.test.ts src/components/EngineSetup.test.ts src/lib/onboarding.test.ts src/components/AccountsPanel.test.ts src/components/ClaudeSignIn.test.ts src/components/DeviceSignIn.test.ts src/components/GrokSignIn.interaction.test.ts src/components/EngineSetup.grok.test.ts src/components/EngineUpdateNotice.test.ts src/components/ModelPicker.test.ts
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
