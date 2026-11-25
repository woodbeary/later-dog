# Sidebar room beside a work panel, November 25

Branch: `desktop/overnight-workpanel-fit`, based on main `4efafe4ce938f485e23bdbd531c184f246249c5c`.

Opening a dog's work panel currently leaves the full sidebar beside it. At widths below 1280px, the selected dog's settings and coding-job panels already fold that sidebar to its 80px rail. This change applies the same policy to the work panel, and closing it restores the saved sidebar density.

The shell reads only whether the work panel is open. Moving from the work page to a step or side job does not redraw the shell. The existing chrome capture fixture now imports the exported header menu and supplies its required props.

## Verification in progress

The same Mac, system headless Chrome, isolated real App, temporary server, repository fake engine, both skins, Reduce Motion enabled. Browser cases: 1100, 1279, 1280, 1281 and 375px, plus 1100 and 375px at simulated 2x UI. The 2x cases halve the CSS viewport and double pixel density so media queries change as they do with browser zoom; native Electron zoom has not been observed.

The gallery sends one fixture turn through the real composer, opens the completed turn's work panel, measures sidebar/chat/panel rectangles, closes the panel, and opens dog settings. It records all geometry and horizontal overflow, preserves before/after images, and separately checks that the repaired chrome fixture renders its menus.

Reproduce, with a Playwright module and Chrome executable available:

```sh
LATERDOG_PANEL_PLAYWRIGHT=/absolute/path/to/playwright-core/index.mjs LATERDOG_PANEL_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node --experimental-strip-types scripts/testing/sidebar-panel-shots.ts after
```

Artifacts: `.laterdog-evidence/sidebar-panel/{before,after}/` in the Mac worktree. Unit, browser, typecheck and lint logs are at `~/laterdog-wt/review/desktop-overnight/workpanel-fit-checks/`. Results will be recorded after inspection.

## Limits

No live engine, account or user data is used. The installed desktop app, native window chrome, real engine activity and motion are not qualified by this fixture. Existing narrow-composer and turn-slot work is checked separately by its owning desktop packages. Full `pnpm gate` on the final clean integration remains required before merge. This is not live yet.
