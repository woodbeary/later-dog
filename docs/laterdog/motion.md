# Motion and tokens in later.dog

The single reference for how the app moves and what it is made of: durations, curves, springs, corner radii, shadows
and hairlines, where each one is used, and the rules they follow. Numbers live in one place,
`src/tokens.css` (imported by `src/styles.css`). `src/lib/motion.ts` carries the same numbers for timers that must
outlive an animation and for the press effect, and `src/lib/motion.test.ts` fails if the two drift apart. Do not write a
millisecond value, a `cubic-bezier(...)`, a pixel radius or a shadow on a surface; use a token.

## Rules

1. **Nothing just appears.** Whatever arrives comes from where it belongs: a menu grows out of the button that opened it,
   a sheet rises from the bottom edge, a side panel slides in from the right, a new message slides in from its own side
   (yours from the right, the dog's from the left). Backdrops fade.
2. **Nothing moves without a reason.** Movement says that something appeared, arrived, answered or was pressed. Rows that
   were already there when a chat opened sit still, so switching chats never plays a wall of entrances.
3. **Pressing answers back.** Any button, menu row, tab or tappable row squishes to 93% while it is held and springs back
   with a small overshoot when let go.
4. **Leaving is slower and flatter than arriving.** Exits take 300 ms on a curve that starts slowly and ends fast, so the
   thing that left does not fight the eye.
5. **Reduced motion turns movement into short fades** (see the last section).

## Durations

| Token | Value | Used for |
| --- | --- | --- |
| `--duration-instant` | 50 ms | Reserved for state flips that must feel immediate (no surface uses it yet). |
| `--duration-fast` | 100 ms | A control answering the pointer: hover and press colours, the press squish going down, a presence dot appearing, the computer panel's tab pill. Alias: `--motion-micro`. |
| `--duration-normal` | 150 ms | Cards and tiles changing colour or border on hover; every entrance under reduced motion (a fade). |
| `--duration-slow` | 200 ms | Something appearing in place: a menu or popover growing (`pop-in`), a message or card sliding in, a backdrop fading in, the composer's corners easing when it grows, the pane behind a tab. Alias: `--motion-base`. |
| `--duration-slower` | 300 ms | Something settling: the mascot at the tail of a turn, the answer growing out of it, a tour beat, a spotlight moving, the mascot's ears easing into a new pose. Alias: `--motion-enter`. |
| `--duration-exit` | 300 ms | Anything leaving: a closing menu (`pop-out`). `MENU_MOTION_MS` keeps a closing menu mounted for exactly this long. |

Loops take whole multiples of these: the working dots step through their opacity holds every five `slower` beats (1.5 s)
with each dot one `slow` beat behind the last; the alert ears overshoot across two `slower` beats. The reply's "emerged"
timer in `ChatView` is one `slower` beat plus one `slow` beat of slack. The welcome tour morphs its card, mascot and title
over one `slower` beat and cross-fades the rest over one `slow` beat.

## Curves

| Token | Value | Used for |
| --- | --- | --- |
| `--ease-enter` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entrances and settles: arrives fast, lands softly. Alias: `--ease-out-soft`. |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | Exits, and the press squish going down. |
| `--ease-loop` | `cubic-bezier(0.45, 0, 0.55, 1)` | Loops that must not show a seam: breathing, flopping, swaying. Alias: `--ease-in-out-soft`. |

## Springs

A spring is mass, stiffness and damping. `src/lib/motion.ts` turns each one into a stepped curve (`springEasing`) and the
time it takes to come to rest (`springDuration`, within 1% of the target); `src/tokens.css` carries the result as
`--spring-<name>` and `--spring-<name>-duration`, and the test checks the two agree.

| Name | Mass, stiffness, damping | Rests after | Used for |
| --- | --- | --- | --- |
| `standard` | 1, 175, 26 | 485 ms | Sheets and dialogs rising (`sheet-in`), the side panel sliding in (`panel-in`). |
| `slow` | 1, 100, 20 | 665 ms | Reserved for large, calm moves (nothing uses it yet). |
| `bounce` | 1, 175, 18.5 | 500 ms | A pressed control springing back; it overshoots by about 5%. |

## Press

`--press-scale` is 0.93 (`PRESS_SCALE`). `src/lib/press.ts`, started once from `src/main.tsx`, listens for the pointer going
down on a button, link, summary, `role` of button, menu item, tab or option, or anything marked `data-press`. It squishes
that element over `--duration-fast`, and when the pointer lifts (or is cancelled, or the window loses focus) it springs
back with the `bounce` spring. It uses the `scale` property, so it never fights an entrance animation's `transform`.

It leaves alone: disabled controls, anything inside `data-no-press`, and surfaces wider than 420 px or taller than 140 px
(squishing a whole panel by 7% reads as a glitch, not a press). Under reduced motion it dims to 70% and back instead.

## Corners

| Token | Value | Used for |
| --- | --- | --- |
| `--radius-bubble` (`rounded-bubble`) | 18 px | Chat bubbles, user and dog, in chats and groups; the error and plain-text bubbles. |
| `--radius-card` (`rounded-card`) | 16 px | Cards in the transcript: approvals, connectors, secrets, requests, routine runs, cloud tasks, screens, the composer's attachment tray. |
| `--radius-question` (`rounded-question`) | 24 px | Question and option cards, the one raised surface in a chat. |
| `--radius-menu` (`rounded-menu`) | 12 px | Menus and popovers: the composer's `+`, command and mention lists, model picker, effort, approval mode, send choice, export, task picker, API keys, call menus. |
| `--radius-sheet` (`rounded-sheet`) | 24 px | Sheets and dialogs: settings, plugins, triggers, voice setup, team pages, confirmations. |
| `--radius-control` (`rounded-control`) | 8 px | `.ui-button` and `.ui-icon-button`. |
| `--radius-composer`, `--radius-composer-expanded` | 22 px, 20 px | The message box, resting and with several lines. |

## Shadows and hairlines

Every shadow ends in a 1 px ring at 5% of the ink colour, so surfaces keep an edge on any skin.

| Token | Shape | Used for |
| --- | --- | --- |
| `--shadow-control` | 0 1px 3px | Small raised controls (available). |
| `--shadow-inline` | 0 4px 12px, 0 2px 4px | Lifted inline surfaces (available). |
| `--shadow-elevated` | inline lift plus an inset 0.5 px hairline | Question and option cards. |
| `--shadow-popover` | 0 10px 20px | Menus and popovers. |
| `--shadow-modal` | 0 20px 32px | Sheets, dialogs and the glass surface. |
| `--shadow-window` | 0 22px 70px | Windows floating over everything (available). |
| `--shadow-composer` | 0 2px 8px, 0 1px 2px | The message box and its tray (its edge is a ring, not a shadow). |

Hairlines are 0.5 px wide (`--hairline-width`) in four strengths of the ink colour: `--hairline-subtle` 5%,
`--hairline-weak` 10%, `--hairline-default` 15%, `--hairline-strong` 30%.

## What arrives

- **Menus and popovers** use `pop-in` (200 ms, `--ease-enter`, from 92% scale) and `pop-out` (300 ms, `--ease-exit`). Each
  menu names its corner with an origin class (`origin-bottom-left`, `origin-top-right`, ...) matching the side it opens
  from, so it grows out of its button. `useMenuMotion` supplies the classes and keeps a closing menu mounted for
  `--duration-exit`.
- **Sheets and dialogs** use `sheet-in` (the `standard` spring, rising 32 px from below and from 97%). A dialog that has
  no animation class of its own gets the same rise from a rule on `.fixed.inset-0` overlays with a dark background, and
  that overlay fades in over `--duration-slow`. Dialogs leave at once for now; only menus keep a closing animation.
- **Side panels** use `panel-in`: the `standard` spring from 28 px to the right.
- **Messages and cards** that land after a chat was opened (`[data-arriving]`, set from `src/lib/arrivals.ts`) slide in
  over `--duration-slow`: yours (`data-from="user"`) from the right edge, everything else from the left, each growing
  from its bottom corner on that side. An answer that emerges from the presence row keeps its own grow (`.turn-answer`).

## The dog

later.dog's dog is a front-facing head per breed, drawn from data in `src/components/dog-breeds.ts` by
`src/components/DogAvatar.tsx` and moved by `src/components/dog-avatar.css`. A person checks the same things in any dog
picture: the ears, a pale muzzle with a big dark nose and a mouth, eyes with a glint. Those parts are shared, so the
roster reads as one family; the breed comes from ear shape, head shape and markings. (An earlier version cut flat
eyes out of a round head; at sidebar size those dogs read as bears and fish.)

- **Construction.** Layers, bottom to top: ears that stand (behind the head), the head, markings clipped to it, a soft
  sheen, the muzzle, ears that hang over the face, wrinkle or curl lines, ink eyes with a white glint, brows (shown only
  in some moods), the tongue, the mouth line and the nose with its glint. Each look gives only the left ear and left
  eye; the right ones mirror.
- **Colour.** Every fill is a tone of the colour the person picked — `fur`, `shade`, `dark`, `deep`, `light`, `white`,
  `inner` — so a breed reads from its shapes and markings in any colour. Only the eyes, nose and mouth are a fixed
  ink, the tongue is pink, and the husky's iris is blue.
- **Breeds.** Retriever (`dog`, the default: ears that fold over and frame the face, a broad pale muzzle), Beagle (long
  low ears, a white blaze that opens into a white muzzle), Shepherd (tall ears, a black cap and dark muzzle over tan
  brows and cheeks), Corgi (very large rounded ears, a white blaze, muzzle and chin with the coat on the outer cheeks),
  Husky (a white mask under a cap with a widow's peak, goggle lines, brow spots, blue eyes), Pug (a square head, a black
  mask that cups big eyes, brow wrinkles, button ears), Poodle (a pom-pom topknot, curly hanging ears, a long clipped
  face) and Chihuahua (huge flared ears on an apple-dome head, big eyes, a short pale snout). The body catalog lists the
  breeds first (round fallback outlines for the native apps); the older abstract shapes stay available under **Shapes**.
- **The mark.** The app icon and the logo are the Retriever drawn from the same data in fixed golden tones on the green
  tile: `node scripts/laterdog-mark.ts && pnpm laterdog:icons` regenerates them, so the icon never drifts from the dogs.
- **Moods.** Every app state maps to one of ten moods, each a still pose plus an optional loop:

| Mood | States | Pose (also the reduced-motion picture) | Loop |
| --- | --- | --- | --- |
| rest | idle, humming, orbit | ears at rest | breathe 3.8s; right ear flicks twice every 7s; blink every 5.4s |
| listen | listening, dictating, receiving, curious | head tilted 5°, ears perked, eyes 10% wider | gentle sway |
| think | thinking, confused, suspicious | eyes up and to the right, one brow raised, one ear raised | head tilts side to side, 3.4s |
| work | working, writing, sending, uploading, loading, dragging, progress | eyes narrowed | bob with squash, 0.72s; ears flop in time |
| search | searching, radar | — | eyes scan, head looks left and right, 1.8s |
| alert | alerting, notifying, scared, surprised, waking, spawning | ears up, eyes wide | one hop with overshoot |
| happy | happy, excited, laughing, playful, celebrate, bouncing, proud | squinting ^ ^ eyes, tongue out | wag 0.5s; ears flop |
| sleep | sleeping, drowsy, powering-down, bored | eyes closed, ears down | slow breath, 5s |
| sad | sad, shy | brows raised at the middle, eyes lowered, ears down | slow breath |
| angry | angry | brows drawn down, eyes narrowed, ears pinned back | a quick shake every 2.2s |

Floppy ears hinge at their root and lift outward; upright ears stand taller to listen and fold back and down when the dog
sleeps, sulks or is cross. The pointer moves the eyes and, a little further, the nose — a parallax that reads as the head
turning. `spin` (a new dog arriving, a celebration) is a quick tail-chasing turn.

## Reduced motion

Under `prefers-reduced-motion: reduce` (and the onboarding preview's `data-reduced-motion="true"` switch):

- Entrances collapse to an opacity-only fade of `--duration-normal` (150 ms): bubbles, cards and tool chips, menus, sheets,
  backdrops, side panels, the computer panel and its panes, presence dots, tour beats and spotlight cards, the mascot at the
  tail of a turn and the answer growing from it.
- A press dims the control to 70% and back instead of squishing it.
- Exits are instant. Everything that loops stops: the working dots hold at 60% opacity, the thinking sheen is plain text.
- The dog keeps its mood's pose with no loop and no transition; the shapes' face engine (`CursorAvatar`) sets its motion
  strength to 0. A paused avatar (`animated={false}`, the sidebar's resting rows) is the same picture.
- The welcome tour skips its view transitions and updates in place.

The stylesheet's catch-all (`* { animation: none; transition-duration: 0.01ms }`) backs all of this; the fades above outrank
it by specificity.

## Checks

`pnpm gen:bodies` twice with no diff; `pnpm exec vitest run scripts/mascot-bodies src/components/Avatar.test.ts
src/components/BotIdentityAvatars.test.ts src/components/BotProfileAvatarCard.test.ts src/components/onboarding
src/lib/motion.test.ts src/lib/arrivals.test.ts`; `pnpm typecheck`; `pnpm lint`. Screenshots of the preview
(`/mascot-preview.html`) and a chat with a row arriving live under `.laterdog-evidence/motion-<date>/`.
