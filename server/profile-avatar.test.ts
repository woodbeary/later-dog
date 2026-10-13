import { describe, expect, it, vi } from "vitest";
import { prepareProfileAvatar } from "./profile-avatar.ts";
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
