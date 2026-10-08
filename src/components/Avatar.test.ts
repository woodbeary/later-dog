import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BotAvatar,
  DogAvatar,
  resolveBotAvatarOutcome,
  type BotAvatarProps,
  type DogAvatarProps,
} from "./Avatar";
import { DEFAULT_MASCOT_BODY, MASCOT_BODIES } from "../../shared/mascot-bodies";
import { BREEDS, DOG_BREEDS } from "./dog-breeds";

const render = (props: Partial<DogAvatarProps>) =>
  renderToStaticMarkup(createElement(DogAvatar, { color: "green", animated: false, ...props }));

const renderBot = (bot: Partial<BotAvatarProps["bot"]>) =>
  renderToStaticMarkup(
    createElement(BotAvatar, { bot: { color: "green", ...bot }, animated: false }),
  );

describe("DogAvatar body", () => {
  it("draws the default dog (a Retriever) with the dog renderer when no body is given", () => {
    expect(DEFAULT_MASCOT_BODY).toBe("dog");
    const markup = render({});
    expect(markup).toContain('data-breed="dog"');
    expect(markup).toContain('class="ld-dog"');
  });

  it("draws every breed with the dog renderer, in the dog's own colour", () => {
    for (const breed of ["beagle", "shepherd", "corgi", "husky", "pug", "poodle", "chihuahua"] as const) {
      const markup = render({ bodyId: breed, state: "thinking" });
      expect(markup, breed).toContain(`data-breed="${breed}"`);
      expect(markup, breed).toContain('data-mood="think"');
      expect(markup, breed).toContain(`data-ears="${BREEDS[breed].ears.kind}"`);
      expect(markup, breed).toContain("--dog-ink:#009957");
    }
  });

  it("wears the body it is given", () => {
    const markup = render({ bodyId: "diamond" });
    expect(markup).toContain(MASCOT_BODIES.diamond.fit);
  });

  it("falls back to the default body for an unknown body", () => {
    // SAFETY: "hexagram" is deliberately not a valid MascotBodyId — this
    // exercises the runtime schema fallback for a value that could arrive
    // from persisted/streamed data, which the type system would otherwise
    // rule out at this call site.
    expect(render({ bodyId: "hexagram" as DogAvatarProps["bodyId"] })).toContain('data-breed="dog"');
  });

  it("paints the body with the per-bot gradient, never a flat black fill", () => {
    const markup = render({ bodyId: "circle" });
    expect(markup).not.toContain('fill="#000000"');
    expect(markup).not.toContain("{{GRADIENT}}");
    expect(markup).toContain("url(#");
  });
});

describe("DogAvatar decorations", () => {
  it("gives every breed two ears, eyes with a glint, a nose and a mouth, and keeps its markings on the head", () => {
    for (const breed of DOG_BREEDS) {
      const markup = render({ bodyId: breed });
      expect(markup.match(/class="ld-dog-ear ld-dog-ear--[lr]"/g), breed).toHaveLength(2);
      expect(markup, breed).toMatch(/class="ld-dog-eye ld-dog-eye--l"><ellipse class="ld-t-ink"/);
      expect(markup, breed).toContain('class="ld-dog-glint"');
      expect(markup, breed).toMatch(/class="ld-dog-nose">[\s\S]*class="ld-t-ink"/);
      expect(markup, breed).toContain('class="ld-dog-mouth ld-s-ink"');
      if (BREEDS[breed].markings?.length) expect(markup, breed).toMatch(/<g clip-path="url\(#[^)]+-head\)"><path class="ld-t-/);
    }
  });

  it("draws ears that hang over the face in front of it, and every other ear behind the head", () => {
    for (const breed of DOG_BREEDS) {
      const markup = render({ bodyId: breed });
      const ear = markup.indexOf("ld-dog-ear--l");
      const head = markup.indexOf('class="ld-dog-head');
      expect(ear > head, breed).toBe(Boolean(BREEDS[breed].ears.front));
    }
  });

  it("paints the dog only in tones of its colour: no fixed fill but an eye's iris", () => {
    for (const breed of DOG_BREEDS) {
      const fills = [...render({ bodyId: breed }).matchAll(/fill="(#[0-9a-fA-F]+)"/g)].map((match) => match[1]);
      expect(fills, breed).toEqual(BREEDS[breed].eyes.iris ? [BREEDS[breed].eyes.iris, BREEDS[breed].eyes.iris] : []);
    }
  });

  it("leaves a plain body without parts", () => {
    expect(render({ bodyId: "diamond" })).not.toContain("mascot-ear");
    expect(render({ bodyId: "diamond" })).not.toContain("ld-dog");
  });

  it("tags the dog with its mood, and stills a paused dog", () => {
    expect(render({ state: "listening" })).toContain('data-mood="listen"');
    expect(render({ state: "sleeping" })).toContain('data-mood="sleep"');
    expect(render({ state: "celebrate" })).toContain('data-mood="happy"');
    expect(render({})).toContain("data-paused");
    expect(render({ animated: true })).not.toContain("data-paused");
  });
});

describe("BotAvatar's two avatar outcomes", () => {
  it("zooms and positions a custom image inside its crop", () => {
    const markup = renderBot({
      avatarUrl: "/api/attachments/cat.webp",
      avatarCrop: "circle",
      avatarZoom: 2,
      avatarFocusX: 0.25,
      avatarFocusY: 0.75,
    });
    expect(markup).toContain("scale(2)");
    expect(markup).toContain("25% 75%");
    expect(markup).toContain("border-radius:50%");
  });

  it("renders a flat cropped image for circle/rounded/square, with no mascot at all", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "circle" });
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<svg");
  });

  it("shows the image as it is, with no mascot face painted on it", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "square" });
    expect(markup).toContain("border-radius:0");
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<image");
    expect(markup).not.toContain("radialGradient");
  });

  it("renders the gradient mascot when the crop is mascot, image or not", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "mascot" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("<svg");
  });

  it("falls back to the gradient mascot when a flat crop has no valid image", () => {
    const markup = renderBot({ avatarUrl: undefined, avatarCrop: "circle" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("<svg");
  });
});

describe("resolveBotAvatarOutcome", () => {
  // `imageFailed` is set by the flat <img>'s own onError, which
  // renderToStaticMarkup never fires — there are no events in a static
  // render. The decision is a pure function precisely so this branch is
  // still testable synchronously.
  it("falls back to the gradient mascot for an image that failed to load", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "circle", hasUrl: true, imageFailed: true }),
    ).toBe("gradientMascot");
  });

  it("renders a good flat image flat", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "rounded", hasUrl: true, imageFailed: false }),
    ).toBe("flatImage");
  });

  it("keeps the mascot crop on the gradient mascot even with a loaded image", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "mascot", hasUrl: true, imageFailed: false }),
    ).toBe("gradientMascot");
  });

  it("falls back to the gradient mascot when there is no image at all", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "square", hasUrl: false, imageFailed: false }),
    ).toBe("gradientMascot");
  });
});
