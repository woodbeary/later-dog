# Motion in later.dog

How the app and its dog move: three durations, two easings, a mascot whose ears carry its state, and one rule for reduced
motion. The design target is the presence-through-motion of Grok Bot's avatars — the mascot shows that it is alive and what
it is doing, and the interface moves only to say that something appeared, arrived or answered.

## Tokens

Declared on `:root` in `src/styles.css`; `src/lib/motion.ts` carries the same durations for timers that must outlive an
animation, and `src/lib/motion.test.ts` fails if the two drift.

| Token | Value | Used for |
| --- | --- | --- |
| `--motion-micro` | 120ms | A control answering the pointer: hover and press colours, a presence dot appearing on an avatar, the computer panel's tab pill. |
| `--motion-base` | 200ms | Something appearing in place: a chat bubble, a tool or approval card, a menu (`pop-in`/`pop-out`), the pane behind a tab in the bot's computer panel, the presence row leaving. |
| `--motion-enter` | 320ms | Something arriving or settling: the mascot at the tail of a turn, the answer growing out of it, a tour beat rising in, the spotlight moving, a side panel sliding in, the mascot's ears easing into a new pose. |
| `--ease-out-soft` | `cubic-bezier(0.22, 1, 0.36, 1)` | Entrances, settles and pose changes: arrives fast, lands softly. |
| `--ease-in-out-soft` | `cubic-bezier(0.45, 0, 0.55, 1)` | Loops that must not show a seam: breathing, flopping, swaying. |

Loops derive their period from the tokens in whole multiples: the working dots step through their opacity holds every five
`enter` beats (1.6s) with each dot one `base` beat behind the last; the alert ears overshoot across two `enter` beats. The
reply's "emerged" timer in `ChatView` is one `enter` beat plus one `base` beat of slack; `MenuMotion` keeps a closing menu
mounted for one `base` beat. The welcome tour (`view-transition.ts`) morphs its card, mascot and title over one `enter`
beat and cross-fades the rest over one `base` beat.

Where a Tailwind utility needs a token: `duration-(--motion-enter)`, `ease-(--ease-out-soft)`.

### What arrives

A transcript row that lands after its chat was opened rises in over one `base` beat (`[data-arriving]` on the row's
`display: contents` wrapper, so bubbles, cards and tool chips all arrive the same way). Rows that were already there when
the chat opened sit still, so switching chats never plays a wall of entrances (`src/lib/arrivals.ts`). An answer that emerges
from the presence row keeps its own grow (`.turn-answer`) instead.

## The dog

later.dog's dog is a front-facing head per breed, drawn from data in `src/components/dog-breeds.ts` by
`src/components/DogAvatar.tsx` and moved by `src/components/dog-avatar.css`. A person checks the same things in any dog
picture: the ears, a pale muzzle with a big dark nose and a mouth, eyes with a glint. Those parts are shared, so the
roster reads as one family; the breed comes from ear shape, head shape and markings. (An earlier version cut flat
eyes out of a round head the way Grok Bot draws its roster; at sidebar size those dogs read as bears and fish.)

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

- Entrances collapse to an opacity-only fade of one `base` beat: bubbles, cards and tool chips, menus, the computer panel and
  its panes, presence dots, tour beats and spotlight cards, the mascot at the tail of a turn and the answer growing from it.
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
