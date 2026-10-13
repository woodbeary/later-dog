import { describe, expect, it, vi } from "vitest";
import { prepareProfileAvatar, submitProfileAvatar } from "./profile-avatar.ts";
import type { BotRecord } from "./store.ts";

const target = { id: "dog", name: "Biscuit", title: "Research", description: "", avatarCrop: "mascot" } as BotRecord;
const config = { imageGen: { key: "fixture-image-key" } };
const make = () => ({
  generate: vi.fn(async () => ({ bytes: Buffer.from("fixture"), mime: "image/png" as const })),
  save: vi.fn(() => ({ path: "/fixture/attachments/avatar.png" })),
});

describe("profile picture proposals", () => {
  it("generates and stores a preview without applying it to the dog", async () => {
    const io = make();
    const result = await prepareProfileAvatar({ config, target, changes: { title: "Astronomer" }, prompt: "a beagle among stars", ...io });
    expect(io.generate).toHaveBeenCalledWith(config, expect.objectContaining({ title: "Astronomer" }), "a beagle among stars");
    expect(result.changes).toEqual({ title: "Astronomer", avatarUrl: "/api/attachments/avatar.png", avatarCrop: "circle" });
    expect(target.avatarUrl).toBeUndefined();
    expect(target.avatarCrop).toBe("mascot");
  });

  it("names the setup path before invoking any generation when unconfigured", async () => {
    const io = make();
    await expect(prepareProfileAvatar({ config: {}, target, changes: {}, prompt: "beagle", ...io })).rejects.toThrow("Generate to add an image API key securely");
    expect(io.generate).not.toHaveBeenCalled();
    expect(io.save).not.toHaveBeenCalled();
  });

  it("refuses malformed accompanying profile changes before generating", async () => {
    const io = make();
    await expect(prepareProfileAvatar({ config, target, changes: { notifications: "yes" }, prompt: "beagle", ...io })).rejects.toThrow();
    expect(io.generate).not.toHaveBeenCalled();
  });
});

describe("generated profile submission", () => {
  it.each(["cancelled", "changed", "deleted"] as const)("discards the generated attachment when its source is %s while awaiting generation", async (reason) => {
    let current: BotRecord | null = { ...target };
    let active = true;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const io = make();
    io.generate.mockImplementation(async () => { await pending; return { bytes: Buffer.from("fixture"), mime: "image/png" }; });
    const discard = vi.fn();
    const submit = vi.fn();
    const result = submitProfileAvatar({ config, target: current, changes: {}, prompt: "beagle", ...io,
      currentTarget: () => current,
      assertActive: () => { if (!active) throw Object.assign(new Error("the internal turn capability has expired"), { status: 401 }); },
      discard, submit,
    });
    if (reason === "cancelled") active = false;
    else if (reason === "changed") current.avatarUrl = "/api/attachments/newer.png";
    else current = null;
    release();
    await expect(result).rejects.toMatchObject({ status: reason === "cancelled" ? 401 : 409 });
    expect(submit).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledExactlyOnceWith("/fixture/attachments/avatar.png");
  });

  it("discards its generated attachment when final profile validation rejects submission", async () => {
    const io = make();
    const discard = vi.fn();
    const error = Object.assign(new Error("target is no longer accessible"), { status: 403 });
    await expect(submitProfileAvatar({ config, target, changes: {}, prompt: "beagle", ...io,
      currentTarget: () => target, assertActive: () => {}, discard,
      submit: () => { throw error; },
    })).rejects.toBe(error);
    expect(discard).toHaveBeenCalledExactlyOnceWith("/fixture/attachments/avatar.png");
  });

  it("retains the attachment referenced by a successful submission", async () => {
    const io = make();
    const discard = vi.fn();
    const assertActive = vi.fn();
    const submit = vi.fn(() => ({ state: "applied" }));
    await expect(submitProfileAvatar({ config, target, changes: {}, prompt: "beagle", ...io,
      currentTarget: () => target, assertActive, discard, submit,
    })).resolves.toEqual({ state: "applied" });
    expect(assertActive).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledExactlyOnceWith({ avatarUrl: "/api/attachments/avatar.png", avatarCrop: "circle" });
    expect(discard).not.toHaveBeenCalled();
  });
});
