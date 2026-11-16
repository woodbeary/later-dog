import { describe, expect, it } from "vitest";
import { appName } from "./app-name";

describe("an app's proper name", () => {
  it("uses the name the app goes by, and words for any other", () => {
    expect(appName("github")).toBe("GitHub");
    expect(appName("googlecalendar")).toBe("Google Calendar");
    expect(appName("zoho_crm")).toBe("Zoho Crm");
  });
});
