import { createRoot } from "react-dom/client";
import "../../src/styles.css";
import type { NativeActivity, NativeActor, NativeRun } from "../../shared/native-runs";
import type { CloudTaskSummary } from "../../shared/cloud-task";
import { openWorkPanel, useWorkPanel, type WorkPanelPage } from "../../src/lib/work-panel";
import { WorkPanelView, type WorkPanelData } from "../../src/components/WorkPanel";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.skin = params.get("skin") === "midnight" ? "midnight" : "daylight";
document.documentElement.dataset.reducedMotion = "true";

const at = (h: number, m: number) => new Date(2026, 10, 17, h, m).getTime();
const NOW = at(9, 41);
const main: NativeActor = { id: "parent", kind: "parent", label: "Juniper", state: "running", startedAt: at(9, 24) };
const puppy: NativeActor = { id: "puppy-1", parentId: "parent", kind: "subagent", label: "Checking the order form on three phone sizes", state: "running", startedAt: NOW - 4 * 60_000, lastActivityAt: NOW - 10_000, background: true, activity: "Opening the order form at 375, 393 and 430 points wide" };
const run: NativeRun = {
  id: "r1", botId: "juniper", threadId: "t1", turnId: "u1", provider: "claudeAgent", revision: 12, startedAt: at(9, 24), state: "running", observation: "live",
  actors: [main, puppy], activityCount: 11, failureCount: 1, limitations: [], nativeActivity: true, lastActivityAt: NOW - 20_000,
  currentActivity: { id: "live-step", actorId: "parent", kind: "tool", label: "Bash", state: "running", startedAt: NOW - 3 * 60_000 },
};
const step = (id: string, label: string, h: number, m: number, subject?: string, over: Partial<NativeActivity> = {}): NativeActivity =>
  ({ id, actorId: "parent", kind: "tool", label, state: "done", startedAt: at(h, m), endedAt: at(h, m) + 20_000, ...(subject ? { subject } : {}), ...over });
const activities: NativeActivity[] = [
  step("s11", "Read", 9, 25, "order form", { input: "src/components/OrderForm.tsx", output: "export function OrderForm() {\n  const [phone, setPhone] = useState(\"\");\n  …" }),
  step("s10", "Grep", 9, 25, "pickup", { startedAt: at(9, 25) + 30_000 }),
  step("s9", "Edit", 9, 27, "order form"),
  step("s8", "Edit", 9, 29, "order store"),
  step("s7", "Bash", 9, 31, "Run the order form tests", { state: "failed", input: "pnpm test order-form", output: "FAIL  order-form.test.ts\n  ✕ keeps the pickup time\n    expected '' to be '12:30'" }),
  step("s6", "Edit", 9, 32, "order form"),
  step("s5", "Bash", 9, 33, "Run the order form tests", { input: "pnpm test order-form", output: "✓ order-form.test.ts (6 tests)" }),
  step("s4", "Bash", 9, 35, "Open the order form to look at it"),
  step("s3", "Task", 9, 37, "Check three phone sizes"),
  step("s2", "Edit", 9, 38, "order form"),
];
const job = { id: "j1", title: "Keeping the order form open to look at it", conversationId: "t1", state: "running", createdAt: new Date(NOW - 6 * 60_000).toISOString(), startedAt: new Date(NOW - 6 * 60_000).toISOString(), updatedAt: new Date(NOW - 60_000).toISOString(), stoppable: true, stage: "Serving the order form on a preview address" } as unknown as CloudTaskSummary;
const done = { ...job, id: "j0", title: "Building the menu pages", stoppable: false, finishedAt: new Date(NOW - 40 * 60_000).toISOString(), updatedAt: new Date(NOW - 40 * 60_000).toISOString() } as unknown as CloudTaskSummary;
const data: WorkPanelData = {
  now: NOW, working: true, run, activities, jobs: [job, done], helpers: [],
  plan: { updatedAt: NOW, items: [
    { text: "Add a pickup time field", status: "done" },
    { text: "Save the time with each order", status: "done" },
    { text: "Check the form on a small phone", status: "in_progress" },
    { text: "Fix anything that looks off", status: "pending" },
    { text: "Tell you what changed", status: "pending" },
  ] },
};

const pages: Record<string, WorkPanelPage> = {
  work: { kind: "work", threadId: "t1" },
  "side-jobs": { kind: "side-jobs", threadId: "t1" },
  step: { kind: "step", threadId: "t1", runId: "r1", activityId: "s7" },
  "side-job": { kind: "side-job", threadId: "t1", jobId: "job:j1" },
};
const start = params.get("page") ?? "work";
if (start === "step" || start === "side-job") openWorkPanel(start === "step" ? pages.work! : pages["side-jobs"]!);
openWorkPanel(pages[start] ?? pages.work!);

function Preview() {
  const page = useWorkPanel();
  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh", background: "var(--color-app)" }}>
      <div style={{ width: 80, borderRight: "1px solid var(--color-hairline)", background: "var(--color-panel)" }} />
      <main style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: "24px 32px", gap: 12, color: "var(--color-ink)", fontSize: 15 }}>
        <div style={{ alignSelf: "flex-end", maxWidth: 420, padding: "10px 14px", borderRadius: 18, background: "var(--color-bubble-user)", color: "var(--color-bubble-user-ink)" }}>Add a pickup time to the order form, and make sure it works on a small phone.</div>
        <div style={{ maxWidth: 420, padding: "10px 14px", borderRadius: 18, background: "var(--color-card)" }}>On it. I'll add the field first, then check the form on a small phone.</div>
        <div style={{ height: 56, borderRadius: 22, border: "1px solid var(--color-hairline)", background: "var(--color-composer)" }} />
      </main>
      {page && <WorkPanelView page={page} botName="Juniper" data={data} hoveredStep={params.get("hover") ?? undefined} actions={{ face: () => null, openDog: () => {}, stopJob: async () => {} }} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
