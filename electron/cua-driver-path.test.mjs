import { describe, expect, it } from "vitest";
import { stagedMacDriver } from "./cua-driver-path.mjs";

const present = (...files) => (file) => files.includes(file);

describe("staged macOS driver lookup", () => {
  it("returns the stage for the running architecture", () => {
    const isFile = present("/repo/dist-native/arm64/cua-driver", "/repo/dist-native/x64/cua-driver");
    expect(stagedMacDriver({ appPath: "/repo", platform: "darwin", arch: "arm64", isFile })).toBe("/repo/dist-native/arm64/cua-driver");
    expect(stagedMacDriver({ appPath: "/repo", platform: "darwin", arch: "x64", isFile })).toBe("/repo/dist-native/x64/cua-driver");
  });

  it("never falls back to the other architecture's stage", () => {
    const isFile = present("/repo/dist-native/x64/cua-driver");
    expect(stagedMacDriver({ appPath: "/repo", platform: "darwin", arch: "arm64", isFile })).toBeNull();
  });

  it("returns null when nothing is staged", () => {
    expect(stagedMacDriver({ appPath: "/repo", platform: "darwin", arch: "arm64", isFile: present() })).toBeNull();
  });

  it("ignores other platforms and unknown architectures", () => {
    const isFile = () => true;
    expect(stagedMacDriver({ appPath: "/repo", platform: "linux", arch: "x64", isFile })).toBeNull();
    expect(stagedMacDriver({ appPath: "/repo", platform: "win32", arch: "x64", isFile })).toBeNull();
    expect(stagedMacDriver({ appPath: "/repo", platform: "darwin", arch: "ia32", isFile })).toBeNull();
    expect(stagedMacDriver({ appPath: "/repo", platform: "darwin", arch: "../x", isFile })).toBeNull();
  });

  it("does not accept a directory in place of the executable", () => {
    expect(stagedMacDriver({ appPath: "/repo", platform: "darwin", arch: "arm64" })).toBeNull();
  });
});
