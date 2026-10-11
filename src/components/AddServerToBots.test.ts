import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ bots: [] as unknown[], dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { bots: fixture.bots }, dispatch: fixture.dispatch }),
}));
import { AddServerToBots, botsWithoutServer } from "./AddServerToBots";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; [key: string]: unknown }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
const bot = (id: string, extra: Partial<Bot> = {}) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), ...extra }) as Bot;

beforeEach(() => {
  fixture.bots = [
    bot("rex", { mcpServers: ["notion"] }),
    bot("scout", { mcpServers: null }),
    bot("pip", { mcpServers: ["tracker"] }),
    bot("ghost", { hidden: true, mcpServers: [] }),
    bot("bare"),
  ];
  fixture.dispatch.mockReset();
});

describe("AddServerToBots", () => {
  it("lists only visible dogs whose own server list leaves the server out", () => {
    expect(botsWithoutServer(fixture.bots as Bot[], "tracker").map((entry) => entry.id)).toEqual(["rex"]);
    expect(botsWithoutServer(fixture.bots as Bot[], "notion").map((entry) => entry.id)).toEqual(["pip"]);
  });

  it("adds the server to that dog's list in one click", () => {
    const tree = AddServerToBots({ server: "tracker" });
    expect(renderToStaticMarkup(tree!)).toContain("Add to Rex");
    nodes(tree).find((node) => node.props["data-add-server-bot"] === "rex")!.props.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "rex", patch: { mcpServers: ["notion", "tracker"] } });
  });

  it("renders nothing when every dog already has it", () => {
    fixture.bots = [bot("scout", { mcpServers: null }), bot("pip", { mcpServers: ["tracker"] })];
    expect(AddServerToBots({ server: "tracker" })).toBeNull();
  });
});
