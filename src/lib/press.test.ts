// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { PRESS_SCALE } from "./motion";
import { installPressFeedback, PRESS_MAX_HEIGHT, PRESS_MAX_WIDTH, pressTarget } from "./press";

function mount(html: string, size?: { width: number; height: number }): HTMLElement {
  document.body.innerHTML = html;
  const element = document.body.firstElementChild as HTMLElement;
  if (size) {
    element.getBoundingClientRect = () => ({ ...size, x: 0, y: 0, top: 0, left: 0, right: size.width, bottom: size.height, toJSON: () => ({}) });
  }
  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-reduced-motion");
});

describe("what squishes", () => {
  it("takes a button, or whatever sits inside one", () => {
    const button = mount('<button><span id="inner">Go</span></button>');
    expect(pressTarget(button.querySelector("#inner"))).toBe(button);
  });

  it("takes rows that act like buttons", () => {
    expect(pressTarget(mount('<div role="menuitem">Rename</div>'))).not.toBeNull();
    expect(pressTarget(mount('<div data-press>Row</div>'))).not.toBeNull();
  });

  it("leaves disabled controls and plain text alone", () => {
    expect(pressTarget(mount("<button disabled>No</button>"))).toBeNull();
    expect(pressTarget(mount('<div role="button" aria-disabled="true">No</div>'))).toBeNull();
    expect(pressTarget(mount("<p>Words</p>"))).toBeNull();
  });

  it("honours an opt-out on the control or anything around it", () => {
    expect(pressTarget(mount("<button data-no-press>No</button>"))).toBeNull();
    const outer = mount('<div data-no-press><button id="b">No</button></div>');
    expect(pressTarget(outer.querySelector("#b"))).toBeNull();
  });

  it("leaves wide or tall surfaces still", () => {
    expect(pressTarget(mount("<button>Wide</button>", { width: PRESS_MAX_WIDTH + 1, height: 32 }))).toBeNull();
    expect(pressTarget(mount("<button>Tall</button>", { width: 100, height: PRESS_MAX_HEIGHT + 1 }))).toBeNull();
    expect(pressTarget(mount("<button>Fits</button>", { width: PRESS_MAX_WIDTH, height: PRESS_MAX_HEIGHT }))).not.toBeNull();
  });
});

describe("press feedback", () => {
  function press(element: HTMLElement) {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  }

  it("squishes on press and springs back on release", () => {
    const button = mount("<button>Go</button>", { width: 80, height: 32 });
    const animate = vi.fn(() => ({ cancel: vi.fn() }));
    button.animate = animate as unknown as typeof button.animate;
    Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
    const remove = installPressFeedback(document);
    press(button);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(animate.mock.calls[0])).toContain(`"scale":${PRESS_SCALE}`);
    button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(animate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(animate.mock.calls[1])).toContain('"scale":"1"');
    remove();
  });

  it("fades instead of moving under reduced motion", () => {
    document.documentElement.dataset.reducedMotion = "true";
    const button = mount("<button>Go</button>", { width: 80, height: 32 });
    const animate = vi.fn(() => ({ cancel: vi.fn() }));
    Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
    const remove = installPressFeedback(document);
    press(button);
    const frames = JSON.stringify(animate.mock.calls[0]);
    expect(frames).toContain('"opacity"');
    expect(frames).not.toContain('"scale"');
    remove();
  });
});
