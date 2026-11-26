import { readContainerFile as read } from "./container-file";
import { describe, expect, it } from "vitest";

const chromiumInstallStep = (dockerfile: string) =>
  dockerfile.split(/\n(?=RUN |COPY |FROM |ENV |EXPOSE |ENTRYPOINT )/).find((step) => /\bchromium\b/.test(step) && step.startsWith("RUN ")) ?? "";

describe("the computer's Chromium launcher", () => {
  it("drops Debian's /dev/shm size check, whose unquoted test breaks under dash on a computer with /dev/shm mounted twice", () => {
    expect(chromiumInstallStep(read("../container/Dockerfile"))).toContain("rm /etc/chromium.d/dev-shm");
  });

  it("still keeps Chromium's shared memory out of the small /dev/shm, which is all that check did", () => {
    expect(read("../container/chromium-flags")).toMatch(/^export CHROMIUM_FLAGS="\$CHROMIUM_FLAGS [^"\n]*--disable-dev-shm-usage[ "]/m);
    expect(read("../container/Dockerfile")).toContain("COPY chromium-flags /etc/chromium.d/laterdog");
  });
});
