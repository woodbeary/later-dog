import { describe, expect, it } from "vitest";
import { stepSubject } from "./step-subject.ts";

describe("what a step is about", () => {
  it.each([
    ["Bash", { command: "pnpm test order-form", description: "Run the order form tests" }, "Run the order form tests"],
    ["mcp__agents__run_on_computer", { command: "pnpm build", description: "Build the app" }, "Build the app"],
    ["Task", { description: "Check the spring menu", prompt: "Read every menu file and list prices" }, "Check the spring menu"],
    ["Agent", { description: "Look over the order form", subagent_type: "general-purpose" }, "Look over the order form"],
  ])("uses the call's own description for %s", (tool, input, subject) => {
    expect(stepSubject(tool, input)).toBe(subject);
  });

  it("never falls back to command text", () => {
    expect(stepSubject("Bash", { command: "rm -rf build && pnpm build" })).toBeUndefined();
    expect(stepSubject("Bash", { command: "pnpm build", description: "   " })).toBeUndefined();
  });

  it.each([
    ["Read", { file_path: "/Users/sam/shop/src/OrderForm.tsx" }, "order form"],
    ["Write", { file_path: "/srv/shop/server/order-store.ts" }, "order store"],
    ["Edit", { file_path: "docs/spring-menu.md", old_string: "a", new_string: "b" }, "spring menu"],
    ["MultiEdit", { file_path: "README.md", edits: [] }, "readme"],
    ["NotebookEdit", { notebook_path: "analysis/SalesReport.ipynb" }, "sales report"],
    ["delete_file", { path: "C:\\menus\\old_menu.txt" }, "old menu"],
    ["mcp__agents__mac_read_file", { path: "~/shop/HTTPServer.ts" }, "http server"],
    ["Read", { file_path: "/srv/shop/order.test.ts" }, "order test"],
  ])("names the file %s works on in plain words", (tool, input, subject) => {
    expect(stepSubject(tool, input)).toBe(subject);
  });

  it.each([
    ["Grep", { pattern: "pickup", path: "/srv/shop" }, "pickup"],
    ["WebSearch", { query: "pickup times near the shop" }, "pickup times near the shop"],
    ["mcp__agents__session_search", { query: "spring menu" }, "spring menu"],
  ])("uses the search words for %s", (tool, input, subject) => {
    expect(stepSubject(tool, input)).toBe(subject);
  });

  it.each([
    ["WebFetch", { url: "https://www.stripe.com/docs", prompt: "Read the docs" }, "stripe.com"],
    ["mcp__computer__open_url", { url: "http://shop.example.org/menu" }, "shop.example.org"],
    ["browser_navigate", { url: "https://WWW.Example.com/" }, "example.com"],
  ])("uses the site's host name for %s", (tool, input, subject) => {
    expect(stepSubject(tool, input)).toBe(subject);
  });

  it("has no subject for anything else or for input it cannot read", () => {
    expect(stepSubject("TodoWrite", { todos: [] })).toBeUndefined();
    expect(stepSubject("coordinate_bots", { message: "Check the menu", description: "Ask Otis" })).toBeUndefined();
    expect(stepSubject("mcp__agents__shared_computer", { action: "read_file", path: "notes.md" })).toBeUndefined();
    expect(stepSubject("WebFetch", { url: "not a link" })).toBeUndefined();
    expect(stepSubject("Read", { file_path: "/srv/shop/" })).toBeUndefined();
    expect(stepSubject("Read", undefined)).toBeUndefined();
    expect(stepSubject("Bash", "pnpm test")).toBeUndefined();
  });

  it("hides a secret-looking token and keeps at most 120 characters", () => {
    const secret = stepSubject("Bash", { command: "deploy", description: "Deploy with key sk-test-notarealkey0000000000 to staging" });
    expect(secret).toBeDefined();
    expect(secret).not.toContain("sk-test-notarealkey0000000000");
    expect(secret).toMatch(/^Deploy with key .+ to staging$/);
    const description = "Run the order form tests again ".repeat(10).slice(0, 300);
    expect(description).toHaveLength(300);
    expect(stepSubject("Bash", { description })).toBe(description.slice(0, 120));
  });
});
