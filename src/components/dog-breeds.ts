// What each breed looks like, as data DogAvatar draws (src/components/DogAvatar.tsx). Every look is a front-facing
// head in a 100-unit box, symmetric about x = 50: only the left ear and left eye are given, the right ones mirror.
//
// Colour is the person's choice, so a breed must read from its shapes and markings in any colour. Every fill is a
// tone of the dog's one colour (`fur`), never a fixed breed colour: a husky's mask is `white` over `fur`, a shepherd's
// saddle is `deep`, a beagle's ears are `shade`. Only the eyes, nose and mouth are a fixed ink, and the tongue pink.
//
// Layers, bottom to top: `back` (behind everything) → ears when they hang behind the head → `head` → `markings`
// (clipped to the head) → `muzzle` (not clipped, so a long snout can drop below the jaw) → `front` (topknots, cheek
// fluff) → ears when `ears.front` → `details` (lines) → eyes → nose → mouth → tongue.

/** The tones a shape can take, all derived from the dog's colour (see dog-avatar.css). */
export type Tone = "fur" | "shade" | "dark" | "deep" | "light" | "white" | "inner" | "ink";
export interface Shape {
  d: string;
  tone: Tone;
}
export interface Line {
  d: string;
  tone: Tone;
  width: number;
}
/** How an ear moves: floppy ears swing from the crown, upright ears pivot at their base, fold and puff ears nod. */
export type EarKind = "floppy" | "upright" | "puff" | "fold";

export interface BreedLook {
  name: string;
  /** The skull and face, in `fur`. */
  head: string;
  markings?: Shape[];
  muzzle?: Shape[];
  back?: Shape[];
  front?: Shape[];
  details?: Line[];
  ears: {
    kind: EarKind;
    /** The left ear's pivot for its poses, in viewBox units. */
    hinge: [number, number];
    /** The left ear, bottom layer first; the right ear is its mirror image. */
    shapes: Shape[];
    /** Draw the ears over the face (floppy ears that frame it, a pug's folded ears) instead of behind the head. */
    front?: boolean;
  };
  /** The left eye's centre and radii; `iris` gives a coloured ring (a husky's blue). */
  eyes: { x: number; y: number; rx: number; ry: number; iris?: string };
  /** The nose's centre and size. */
  nose: { y: number; w: number; h: number };
  /** Where the mouth's two curves end (`y`) and how far each reaches from the centre (`w`). */
  mouth: { y: number; w: number };
}

export const DOG_BREEDS = ["dog", "beagle", "shepherd", "corgi", "husky", "pug", "poodle", "chihuahua"] as const;
export type DogBreed = (typeof DOG_BREEDS)[number];

// A golden retriever: broad soft skull, ears set at the temples that fold over and hang to the jaw, an even golden
// coat and a broad pale muzzle.
const retriever: BreedLook = {
  name: "Retriever",
  head: "M50 19C63 19 73 24 78 33C82 40 83 49 82 57C81 66 76 74 68 79C63 83 57 85 50 85C43 85 37 83 32 79C24 74 19 66 18 57C17 49 18 40 22 33C27 24 37 19 50 19Z",
  muzzle: [
    { tone: "white", d: "M50 55.5C58.5 55.5 65 59.5 67 65.5C69 72.5 65 79.5 58.5 83C55.5 84.5 44.5 84.5 41.5 83C35 79.5 31 72.5 33 65.5C35 59.5 41.5 55.5 50 55.5Z" },
  ],
  ears: {
    kind: "floppy",
    hinge: [29, 29],
    front: true,
    shapes: [
      { tone: "shade", d: "M31.5 27C24 25.5 16.5 29 13.5 36.5C10.5 44 10.5 55 12.5 63C14 69.5 17.5 74 22 73.5C26.5 73 28.5 68.5 28.5 63C28.5 56 27 49.5 27.3 43.5C27.6 37.5 29.2 31.5 31.5 27Z" },
    ],
  },
  eyes: { x: 38.5, y: 47, rx: 4.3, ry: 4.7 },
  nose: { y: 62.5, w: 15, h: 10 },
  mouth: { y: 73, w: 7.5 },
};

// A beagle: long low-set ears that hang past the jaw, a white blaze from the forehead that opens into a white muzzle.
const beagle: BreedLook = {
  name: "Beagle",
  head: "M50 20C62 20 71 25 75.5 34C79.5 42 80 51 79 59C78 68 73 76 66 80.5C61 83.5 56 85 50 85C44 85 39 83.5 34 80.5C27 76 22 68 21 59C20 51 20.5 42 24.5 34C29 25 38 20 50 20Z",
  markings: [
    { tone: "white", d: "M50 23C52.5 23 53.6 28 54 34C54.4 40 54.5 45 56.5 50C59 55 66 58 68 64C70.5 72 66 80 58 83.5C55 85 45 85 42 83.5C34 80 29.5 72 32 64C34 58 41 55 43.5 50C45.5 45 45.6 40 46 34C46.4 28 47.5 23 50 23Z" },
  ],
  muzzle: [
    { tone: "white", d: "M50 56C57.5 56 63.5 60 65.5 65.5C67.5 72 64 78.5 58 81.5C55 83 45 83 42 81.5C36 78.5 32.5 72 34.5 65.5C36.5 60 42.5 56 50 56Z" },
  ],
  ears: {
    kind: "floppy",
    hinge: [32, 28],
    front: true,
    shapes: [
      { tone: "dark", d: "M35 27C26 25.5 16.5 30.5 13 40.5C9.5 50 9.5 64 11.5 74C13 81.5 17 87.5 22.5 87.5C28 87.5 30.5 81 30.5 73.5C30.5 63 28.5 53 29 45C29.5 37.5 31.5 31 35 27Z" },
    ],
  },
  eyes: { x: 38, y: 48.5, rx: 4.6, ry: 5 },
  nose: { y: 63.5, w: 14, h: 9.5 },
  mouth: { y: 73.5, w: 7 },
};

// A German Shepherd: tall, wide-based ears that stand up and a little out, a wedge-shaped head with a long muzzle,
// and the black-and-tan pattern: a black cap with a slim wing towards each eye and a point down the forehead into a
// black muzzle, tan brows above the eyes and tan cheeks. The muzzle is a shade lighter than the cap so the nose reads.
const shepherd: BreedLook = {
  name: "Shepherd",
  head: "M50 25.5C62 25.5 72.5 29 77.5 36.5C81 42 81 50 79.5 57C78 64.5 73.5 71 68 77C63.5 82 57.5 88 50 88C42.5 88 36.5 82 32 77C26.5 71 22 64.5 20.5 57C19 50 19 42 22.5 36.5C27.5 29 38 25.5 50 25.5Z",
  markings: [
    { tone: "deep", d: "M13 10H87V37.5C81 38.5 74 41.5 68.8 44.8C70 41.5 67.5 35.6 62.5 35.5C58.5 35.4 56.2 37.5 55.5 40.5C54.5 44 52 47.5 50 49.5C48 47.5 45.5 44 44.5 40.5C43.8 37.5 41.5 35.4 37.5 35.5C32.5 35.6 30 41.5 31.2 44.8C26 41.5 19 38.5 13 37.5Z" },
  ],
  muzzle: [
    { tone: "dark", d: "M50 41.5C53.2 41.5 54.6 45 55.5 49C56.5 53.5 59.5 57.5 61.8 61.5C64.5 66.5 65.2 73 64 78.5C62.5 84.5 57 88 50 88C43 88 37.5 84.5 36 78.5C34.8 73 35.5 66.5 38.2 61.5C40.5 57.5 43.5 53.5 44.5 49C45.4 45 46.8 41.5 50 41.5Z" },
  ],
  ears: {
    kind: "upright",
    hinge: [41, 31],
    shapes: [
      { tone: "dark", d: "M28.5 42C25 37 22 26 21.5 14C21.3 9 21.8 5.5 23.5 4.5C25.5 3.5 27.5 5 29.5 7C35 12.5 41.5 19.5 46 26.5C47 28 47 31 45.5 33C40 37 34 40 28.5 42Z" },
      { tone: "inner", d: "M30 37C27.5 31 25.5 23 25.3 16C25.2 12.5 26 10.5 27.5 11.3C32 15 37.5 21 41.5 28C38 32 34 35 30 37Z" },
    ],
  },
  eyes: { x: 37.5, y: 47, rx: 4.2, ry: 4.6 },
  nose: { y: 66, w: 14.5, h: 9.8 },
  mouth: { y: 78, w: 7.5 },
};

// A Siberian Husky: thick triangular ears set high and close, white inside; a white mask (spectacles that run out
// towards the ears, cheeks, muzzle) under a cap that comes to a widow's peak between the eyes, a goggle line from the
// hood to each eye's outer corner, white spots above the eyes, and pale blue eyes.
const husky: BreedLook = {
  name: "Husky",
  head: "M50 24C61 24 70.5 28 75.5 35.5C80 42 81 50 80.5 58C80 66 76 73 70 78C65 82 58 86.5 50 86.5C42 86.5 35 82 30 78C24 73 20 66 19.5 58C19 50 20 42 24.5 35.5C29.5 28 39 24 50 24Z",
  markings: [
    { tone: "white", d: "M50 51.5C51.5 48.5 53 45 54 42C55 39.5 57.5 37.8 61.5 37.8C66.5 37.8 71.5 38.7 75 41C72.2 43 69.7 45 67.8 47.8C70.5 46.7 73.7 46 76.5 46C76.7 48.5 76.5 51.5 76.5 55C76.5 58.5 74.5 61.5 73 65.5C72 68.5 69.5 72 66 76C62.5 80.5 57.5 85.5 50 85.5C42.5 85.5 37.5 80.5 34 76C30.5 72 28 68.5 27 65.5C25.5 61.5 23.5 58.5 23.5 55C23.5 51.5 23.3 48.5 23.5 46C26.3 46 29.5 46.7 32.2 47.8C30.3 45 27.8 43 25 41C28.5 38.7 33.5 37.8 38.5 37.8C42.5 37.8 45 39.5 46 42C47 45 48.5 48.5 50 51.5Z" },
    { tone: "white", d: "M35.8 33A3.2 2 0 1 0 42.2 33A3.2 2 0 1 0 35.8 33Z" },
    { tone: "white", d: "M57.8 33A3.2 2 0 1 0 64.2 33A3.2 2 0 1 0 57.8 33Z" },
  ],
  ears: {
    kind: "upright",
    hinge: [43, 29],
    shapes: [
      { tone: "shade", d: "M28.5 38C26.8 30.5 27 19 29.5 11.5C30.6 8.6 33.8 7.6 36.2 9.8C41 14.3 45.2 20 48 25.8C48.7 27.4 48.4 30.2 47 31.5C41.5 34.5 35 36.5 28.5 38Z" },
      { tone: "white", d: "M32.5 33.5C31.8 27.5 32.2 21.5 33.8 16.8C34.4 15.2 36 14.8 37.1 15.9C40 18.9 42.3 22.3 43.9 25.9C40.5 28.8 36.7 31.4 32.5 33.5Z" },
    ],
  },
  eyes: { x: 38.5, y: 48.5, rx: 4.9, ry: 5.2, iris: "#8fd0ff" },
  nose: { y: 64.5, w: 13.5, h: 9 },
  mouth: { y: 75, w: 7 },
};

// A Pembroke Welsh Corgi: very large upright ears with rounded tips, standing tall and a little outward; a fox-like
// face widest at the cheeks that narrows to the muzzle; a narrow white blaze up the forehead that opens into a white
// muzzle and chin, with the coat colour running down the outer cheeks to the jaw.
const corgi: BreedLook = {
  name: "Corgi",
  head: "M50 28C63 28 73.5 31.5 79 39C84.5 46.5 87 54 86 61C85 68 79.5 76 71 82C64.5 86.5 57.5 90 50 90C42.5 90 35.5 86.5 29 82C20.5 76 15 68 14 61C13 54 15.5 46.5 21 39C26.5 31.5 37 28 50 28Z",
  markings: [
    { tone: "white", d: "M50 29.5C52 29.5 53 33 53.5 38.5C54 45 54 50.5 55.2 55C56.5 59.5 60 61 64.5 61C70.5 61 75 65 76 71C77 77 76 80 80 84L80 96L20 96L20 84C24 80 23 77 24 71C25 65 29.5 61 35.5 61C40 61 43.5 59.5 44.8 55C46 50.5 46 45 46.5 38.5C47 33 48 29.5 50 29.5Z" },
  ],
  ears: {
    kind: "upright",
    hinge: [32, 37],
    shapes: [
      { tone: "fur", d: "M22 52C18.5 41 14 27 13.2 16C12.6 8.5 16.5 3.5 22.5 5C30.5 7 39.5 16 44.5 25.5C46.5 29.5 48 34.5 48.5 40C40 45 31 49.5 22 52Z" },
      { tone: "inner", d: "M25.5 48C22.5 39 19 29 18.6 20C18.3 14.5 21.5 11.5 26 13C32 15.5 37.5 22.5 40.5 29.5C42 33 43 37 43.5 41C37.5 44 31.5 46.5 25.5 48Z" },
    ],
  },
  eyes: { x: 38.5, y: 52.5, rx: 4.8, ry: 5.1 },
  nose: { y: 68, w: 14, h: 9.5 },
  mouth: { y: 78.5, w: 8 },
};

// A Chihuahua: an apple-dome head, small next to its enormous ears, which are set at the sides of the dome and flare
// out about 40 degrees; big round wide-set eyes; a short, small, slightly pointed pale muzzle with a small nose.
const chihuahua: BreedLook = {
  name: "Chihuahua",
  head: "M50 30.5C65.5 30.5 78.5 41.5 78.5 56.5C78.5 66 74 74 67 79.5C62 83.5 56.5 86 50 86C43.5 86 38 83.5 33 79.5C26 74 21.5 66 21.5 56.5C21.5 41.5 34.5 30.5 50 30.5Z",
  muzzle: [
    { tone: "light", d: "M50 58C54.5 58 57 61 59.5 64.5C62.5 68.5 64.5 72 64 76C63.5 81 57.5 85.5 50 85.5C42.5 85.5 36.5 81 36 76C35.5 72 37.5 68.5 40.5 64.5C43 61 45.5 58 50 58Z" },
  ],
  ears: {
    kind: "upright",
    hinge: [36, 37],
    shapes: [
      { tone: "fur", d: "M28.6 60.6C19 51.2 10.6 38.8 7.7 26.9C6.2 20 8.2 12.4 14.2 11.5C22.6 10.4 31.6 17.3 37.8 26.8C40.6 31.2 43 36.5 44.4 42.4C38.9 49.8 33.8 56.2 28.6 60.6Z" },
      { tone: "inner", d: "M30.3 55.9C22.2 48 16 37.9 13.4 29.1C12 24.1 14.2 19.5 18.7 19.2C25.2 19.2 31.1 24.3 35.5 30.5C38.3 34.3 40.1 38.7 41 43.7C37.3 48.4 34.1 52.7 30.3 55.9Z" },
    ],
  },
  eyes: { x: 36, y: 56.5, rx: 6.4, ry: 6.7 },
  nose: { y: 70, w: 12.5, h: 8.4 },
  mouth: { y: 78.5, w: 6.5 },
};

// A pug: a wide, squarish head; a short flat face under a black mask that rises between the big round eyes and
// cups them, with jowls; wrinkles on the brow and a roll over the small nose; small folded button ears at the corners.
const pug: BreedLook = {
  name: "Pug",
  head: "M50 20.5C37.5 20.5 27 22.5 21 28C15.5 33 13.5 41.5 13.5 51C13.5 61 16 70 21.5 76.5C27 82.5 37.5 85.5 50 85.5C62.5 85.5 73 82.5 78.5 76.5C84 70 86.5 61 86.5 51C86.5 41.5 84.5 33 79 28C73 22.5 62.5 20.5 50 20.5Z",
  markings: [
    { tone: "deep", d: "M50 40C46.5 40 40.2 41.5 40.2 46C40.2 49.4 37.4 52.2 34 52.2C30.6 52.2 27.8 49.4 27.8 46C27.8 44.6 27.2 43.6 26.3 43.6C25.3 43.6 24.8 45.5 25 48.5C25.3 53.5 27.3 59 29.5 64.5C31.5 70.5 35.5 76 41 76.8C44.8 77.2 48 76.5 50 75C52 76.5 55.2 77.2 59 76.8C64.5 76 68.5 70.5 70.5 64.5C72.7 59 74.7 53.5 75 48.5C75.2 45.5 74.7 43.6 73.7 43.6C72.8 43.6 72.2 44.6 72.2 46C72.2 49.4 69.4 52.2 66 52.2C62.6 52.2 59.8 49.4 59.8 46C59.8 41.5 53.5 40 50 40Z" },
  ],
  details: [
    { tone: "dark", width: 1.9, d: "M45 30C47.5 28.2 52.5 28.2 55 30" },
    { tone: "dark", width: 1.9, d: "M44 34.8C45.6 33.1 48.3 33.1 50 34.6C51.7 33.1 54.4 33.1 56 34.8" },
    { tone: "shade", width: 2.2, d: "M43 50.5C45.5 47 54.5 47 57 50.5" },
  ],
  ears: {
    kind: "fold",
    hinge: [27, 25],
    front: true,
    shapes: [
      { tone: "deep", d: "M15 31C18 25 26 20.5 35.5 20C34 27 29.5 35.5 23.5 42.5C21.5 44.5 19 44 17.8 41.5C16 38 15 34.5 15 31Z" },
      { tone: "dark", d: "M15 31C18 25 26 20.5 35.5 20C27.5 22.5 21 26.5 17.3 33.5C16.2 33 15 32.2 15 31Z" },
    ],
  },
  eyes: { x: 34, y: 46, rx: 6.5, ry: 6.5 },
  nose: { y: 55.5, w: 12, h: 8 },
  mouth: { y: 67, w: 8.5 },
};

// A show poodle: a round pom-pom topknot of curls on the crown, long ears hanging beside the face as clouds of
// curls, and between them a smooth, narrow clipped face with a long muzzle, the nose at its end, and small almond eyes.
const poodle: BreedLook = {
  name: "Poodle",
  head: "M50 30C39.5 30 32 35 31 43.5C30 51.5 32.5 58 36 64C38.5 68.5 39.5 75 40 80C40.5 85 44.5 87.5 50 87.5C55.5 87.5 59.5 85 60 80C60.5 75 61.5 68.5 64 64C67.5 58 70 51.5 69 43.5C68 35 60.5 30 50 30Z",
  front: [
    { tone: "shade", d: "M43.5 10.8A6.8 6.8 0 1 0 57.1 10.8A6.8 6.8 0 1 0 43.5 10.8ZM51.9 13.4A6.8 6.8 0 1 0 65.5 13.4A6.8 6.8 0 1 0 51.9 13.4ZM56.3 19.9A6.8 6.8 0 1 0 69.9 19.9A6.8 6.8 0 1 0 56.3 19.9ZM54.8 27.3A6.8 6.8 0 1 0 68.4 27.3A6.8 6.8 0 1 0 54.8 27.3ZM47.9 32.1A6.8 6.8 0 1 0 61.5 32.1A6.8 6.8 0 1 0 47.9 32.1ZM39.1 32.1A6.8 6.8 0 1 0 52.7 32.1A6.8 6.8 0 1 0 39.1 32.1ZM32.2 27.3A6.8 6.8 0 1 0 45.8 27.3A6.8 6.8 0 1 0 32.2 27.3ZM30.7 19.9A6.8 6.8 0 1 0 44.3 19.9A6.8 6.8 0 1 0 30.7 19.9ZM35.1 13.4A6.8 6.8 0 1 0 48.7 13.4A6.8 6.8 0 1 0 35.1 13.4ZM38.5 21.8A11.8 11.8 0 1 0 62.1 21.8A11.8 11.8 0 1 0 38.5 21.8Z" },
    { tone: "fur", d: "M43.5 9.5A6.5 6.5 0 1 0 56.5 9.5A6.5 6.5 0 1 0 43.5 9.5ZM51.9 12.1A6.5 6.5 0 1 0 64.9 12.1A6.5 6.5 0 1 0 51.9 12.1ZM56.3 18.6A6.5 6.5 0 1 0 69.3 18.6A6.5 6.5 0 1 0 56.3 18.6ZM54.8 26A6.5 6.5 0 1 0 67.8 26A6.5 6.5 0 1 0 54.8 26ZM47.9 30.8A6.5 6.5 0 1 0 60.9 30.8A6.5 6.5 0 1 0 47.9 30.8ZM39.1 30.8A6.5 6.5 0 1 0 52.1 30.8A6.5 6.5 0 1 0 39.1 30.8ZM32.2 26A6.5 6.5 0 1 0 45.2 26A6.5 6.5 0 1 0 32.2 26ZM30.7 18.6A6.5 6.5 0 1 0 43.7 18.6A6.5 6.5 0 1 0 30.7 18.6ZM35.1 12.1A6.5 6.5 0 1 0 48.1 12.1A6.5 6.5 0 1 0 35.1 12.1ZM38.5 20.5A11.5 11.5 0 1 0 61.5 20.5A11.5 11.5 0 1 0 38.5 20.5Z" },
    { tone: "shade", d: "M47.3 16.3A4.2 4.2 0 0 1 39.7 16.3A8.3 8.3 0 0 0 47.3 16.3ZM58 17.5A4 4 0 0 1 52.9 11.4A5 5 0 0 0 58 17.5ZM53.6 23.4A4.5 4.5 0 0 1 45.4 23.4A8.8 8.8 0 0 0 53.6 23.4ZM41.4 27.8A4 4 0 0 1 37.4 20.9A5 5 0 0 0 41.4 27.8ZM63.1 24.7A4 4 0 0 1 55.9 24.7A7.7 7.7 0 0 0 63.1 24.7ZM54.1 31.3A3.8 3.8 0 0 1 47.6 32.4A9.3 9.3 0 0 0 54.1 31.3Z" },
    { tone: "light", d: "M38.1 11.1A4.2 4.2 0 0 1 43.4 8.6ZM46.9 7.4A4.2 4.2 0 0 1 52.6 5.9ZM32.6 18.8A4 4 0 0 1 36.5 15.5Z" },
  ],
  ears: {
    kind: "puff",
    hinge: [31, 41],
    front: true,
    shapes: [
      { tone: "shade", d: "M23.5 44.3A5.8 5.8 0 1 0 35.1 44.3A5.8 5.8 0 1 0 23.5 44.3ZM16 46.3A6.8 6.8 0 1 0 29.6 46.3A6.8 6.8 0 1 0 16 46.3ZM11.5 53.3A6.8 6.8 0 1 0 25.1 53.3A6.8 6.8 0 1 0 11.5 53.3ZM10 62.3A6.8 6.8 0 1 0 23.6 62.3A6.8 6.8 0 1 0 10 62.3ZM10.5 71.3A6.8 6.8 0 1 0 24.1 71.3A6.8 6.8 0 1 0 10.5 71.3ZM13.5 79.3A6.8 6.8 0 1 0 27.1 79.3A6.8 6.8 0 1 0 13.5 79.3ZM21 82.3A6.3 6.3 0 1 0 33.6 82.3A6.3 6.3 0 1 0 21 82.3ZM24 75.3A5.8 5.8 0 1 0 35.6 75.3A5.8 5.8 0 1 0 24 75.3ZM24.5 65.3A5.8 5.8 0 1 0 36.1 65.3A5.8 5.8 0 1 0 24.5 65.3ZM24.5 54.3A5.8 5.8 0 1 0 36.1 54.3A5.8 5.8 0 1 0 24.5 54.3ZM14 63.3A9.8 9.8 0 1 0 33.6 63.3A9.8 9.8 0 1 0 14 63.3ZM16.5 51.3A7.8 7.8 0 1 0 32.1 51.3A7.8 7.8 0 1 0 16.5 51.3ZM15.5 73.3A8.3 8.3 0 1 0 32.1 73.3A8.3 8.3 0 1 0 15.5 73.3Z" },
      { tone: "fur", d: "M23 43A5.5 5.5 0 1 0 34 43A5.5 5.5 0 1 0 23 43ZM15.5 45A6.5 6.5 0 1 0 28.5 45A6.5 6.5 0 1 0 15.5 45ZM11 52A6.5 6.5 0 1 0 24 52A6.5 6.5 0 1 0 11 52ZM9.5 61A6.5 6.5 0 1 0 22.5 61A6.5 6.5 0 1 0 9.5 61ZM10 70A6.5 6.5 0 1 0 23 70A6.5 6.5 0 1 0 10 70ZM13 78A6.5 6.5 0 1 0 26 78A6.5 6.5 0 1 0 13 78ZM20.5 81A6 6 0 1 0 32.5 81A6 6 0 1 0 20.5 81ZM23.5 74A5.5 5.5 0 1 0 34.5 74A5.5 5.5 0 1 0 23.5 74ZM24 64A5.5 5.5 0 1 0 35 64A5.5 5.5 0 1 0 24 64ZM24 53A5.5 5.5 0 1 0 35 53A5.5 5.5 0 1 0 24 53ZM13.5 62A9.5 9.5 0 1 0 32.5 62A9.5 9.5 0 1 0 13.5 62ZM16 50A7.5 7.5 0 1 0 31 50A7.5 7.5 0 1 0 16 50ZM15 72A8 8 0 1 0 31 72A8 8 0 1 0 15 72Z" },
      { tone: "shade", d: "M27.1 50.9A4.5 4.5 0 0 1 18.9 50.9A8.1 8.1 0 0 0 27.1 50.9ZM22.1 64.3A4.6 4.6 0 0 1 17.5 56.5A5.6 5.6 0 0 0 22.1 64.3ZM28.1 72.4A4.5 4.5 0 0 1 19.9 72.4A8.1 8.1 0 0 0 28.1 72.4ZM31.2 59.2A3.4 3.4 0 0 1 25.1 59.7A6.6 6.6 0 0 0 31.2 59.2ZM22.9 80.2A3.6 3.6 0 0 1 16.7 81.3A8.4 8.4 0 0 0 22.9 80.2Z" },
      { tone: "light", d: "M17.7 43.4A4.6 4.6 0 0 1 23.6 40.7ZM12.2 58.7A4.4 4.4 0 0 1 16.5 55.1Z" },
    ],
  },
  eyes: { x: 41.5, y: 48.5, rx: 4.1, ry: 3.2 },
  nose: { y: 71, w: 11, h: 7.5 },
  mouth: { y: 80, w: 6.5 },
};

export const BREEDS: Record<DogBreed, BreedLook> = {
  dog: retriever,
  beagle,
  shepherd,
  corgi,
  husky,
  pug,
  poodle,
  chihuahua,
};
