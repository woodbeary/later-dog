import { describe, expect, it } from "vitest";

import { claudeSignInLink, googleSignInLink } from "./ClaudeSignIn";

describe("the Claude sign-in link shown in Settings", () => {
  it("is only ever Anthropic's own page over https", () => {
    expect(claudeSignInLink("https://claude.com/cai/oauth/authorize?code=true&state=x")).toBe("https://claude.com/cai/oauth/authorize?code=true&state=x");
    expect(claudeSignInLink("https://console.anthropic.com/oauth/authorize")).toBeTruthy();
    expect(claudeSignInLink("https://sub.claude.ai/x")).toBeTruthy();
    expect(claudeSignInLink("http://claude.com/x")).toBeNull();
    expect(claudeSignInLink("https://claude.com.evil.example/x")).toBeNull();
    expect(claudeSignInLink("https://evil.example/?u=https://claude.com")).toBeNull();
    expect(claudeSignInLink("https://a:b@claude.com/x")).toBeNull();
    expect(claudeSignInLink(null)).toBeNull();
    expect(claudeSignInLink("not a url")).toBeNull();
  });
});

describe("the Google sign-in link shown for Antigravity", () => {
  const link = "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=fixture&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=x";

  it("is only ever accounts.google.com over https, with no user info and no port", () => {
    expect(googleSignInLink(link)).toBe(link);
    expect(googleSignInLink("https://ACCOUNTS.GOOGLE.COM/o/oauth2/auth")).toBe("https://accounts.google.com/o/oauth2/auth");
    expect(googleSignInLink("http://accounts.google.com/o/oauth2/auth")).toBeNull();
    expect(googleSignInLink("https://accounts.google.com.evil.example/o/oauth2/auth")).toBeNull();
    expect(googleSignInLink("https://evil.accounts.google.com/o/oauth2/auth")).toBeNull();
    expect(googleSignInLink("https://google.com/o/oauth2/auth")).toBeNull();
    expect(googleSignInLink("https://evil.example/?u=https://accounts.google.com")).toBeNull();
    expect(googleSignInLink("https://a:b@accounts.google.com/o/oauth2/auth")).toBeNull();
    expect(googleSignInLink("https://someone@accounts.google.com/o/oauth2/auth")).toBeNull();
    expect(googleSignInLink("https://accounts.google.com:8443/o/oauth2/auth")).toBeNull();
    expect(googleSignInLink("https://accounts.google.com:443/o/oauth2/auth")).toBeNull();
    expect(googleSignInLink("https://claude.com/cai/oauth/authorize")).toBeNull();
    expect(googleSignInLink(null)).toBeNull();
    expect(googleSignInLink("not a url")).toBeNull();
  });
});
