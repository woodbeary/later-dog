import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRightIcon, CheckCircledIcon, Cross2Icon, ExclamationTriangleIcon, GitHubLogoIcon, GlobeIcon, PlusIcon, ReloadIcon } from "@radix-ui/react-icons";
import type { Job, JobEvent, Repository, WorkspaceSnapshot } from "../../shared/laterdog";
import { copyText } from "@/lib/copy-text";

interface GitHubSignIn { phase: "idle" | "waiting" | "done" | "failed"; code?: string; url?: string; detail?: string }
interface GitHubAccess { authenticated: boolean; source: string; login?: string; detail?: string; signIn?: GitHubSignIn }

const labels: Record<Job["state"],string> = { queued: "Queued", preparing: "Preparing workspace", submitting: "Submitting", submission_unknown: "Submission uncertain", running: "Working in cloud", collecting: "Collecting result", ready: "Result collected", publishing: "Publishing PR", verifying: "Verifying", needs_attention: "Needs attention", cancelled: "Cancelled", merged: "Merged" };
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/laterdog${path}`,{ method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Workspace request failed (${response.status})`); return result;
}
function Dialog({ title, close, children, error }: { title: string; close: () => void; children: ReactNode; error?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); },[]);
  return <dialog ref={ref} onCancel={close} className="m-auto w-[min(560px,calc(100vw-32px))] rounded-2xl border border-border bg-panel p-0 text-ink shadow-xl backdrop:bg-black/30">
    <div className="flex items-center justify-between border-b border-border px-6 py-4"><h2 className="text-base font-semibold">{title}</h2><button aria-label="Close dialog" onClick={close} className="rounded-lg p-2 hover:bg-raised"><Cross2Icon /></button></div>
    {error && <p role="alert" className="mx-6 mt-4 rounded-lg border border-danger/30 p-3 text-sm text-danger">{error}</p>}
    {children}
  </dialog>;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex flex-col gap-2 text-sm"><span className="font-medium">{label}</span>{children}</label>;
}
const inputStyle = "w-full rounded-lg border border-border bg-app px-3 py-2.5 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent";
const primaryButton = "inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink transition-transform active:scale-[.98] disabled:opacity-50";
const secondaryButton = "inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-panel px-3 py-2 text-sm transition-colors hover:bg-raised disabled:opacity-40";

export function LaterDogWorkspace({ conversationId, botId, openConversation }: { conversationId?: string; botId?: string; openConversation?: (job: Job) => void }) {
  const [workspace,setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [error,setError] = useState(""); const [selected,setSelected] = useState<string | null>(null);
  const [events,setEvents] = useState<JobEvent[]>([]); const [modal,setModal] = useState<"job" | "repo" | "pair" | null>(null);
  const [pending,setPending] = useState(false); const [correction,setCorrection] = useState("");
  const [pairCode,setPairCode] = useState("");
  // GitHub access as the supervisor itself sees it (`gh api user` there, never here): a supervisor without a GitHub login
  // cannot open PRs, and that should be visible — and fixable in one click — before the first publish fails.
  const [github,setGithub] = useState<GitHubAccess | null>(null);
  const connected = workspace !== null;
  const signingIn = github?.signIn?.phase === "waiting";
  useEffect(() => { if (!connected) return; const abort = new AbortController();
    const check = () => request<GitHubAccess>("/github/access",undefined,abort.signal).then(setGithub).catch(() => { if (!abort.signal.aborted) setGithub(null); });
    void check();
    // While a device sign-in waits for the person, look again every few seconds so "Connected" appears on its own.
    const timer = signingIn ? setInterval(() => void check(),4000) : undefined;
    return () => { abort.abort(); if (timer) clearInterval(timer); }; },[connected,signingIn]);
  const connectGitHub = async () => {
    try { const signIn = await request<GitHubSignIn>("/github/login",{}); setGithub((current) => current ? { ...current, signIn } : current); if (signIn.url) window.open(signIn.url,"_blank","noopener"); }
    catch (err) { setError(err instanceof Error ? err.message : "GitHub sign-in could not start"); }
  };
  const delegationKey = useRef(crypto.randomUUID());
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try { const snapshot = await request<WorkspaceSnapshot>("/workspace",undefined,signal); setWorkspace(snapshot); setError(""); }
    catch (err) { if (!signal?.aborted) setError(err instanceof Error ? err.message : "Workspace unavailable"); }
  },[]);
  useEffect(() => { const abort = new AbortController(); void refresh(abort.signal); const timer = setInterval(() => void refresh(abort.signal),5000);
    return () => { abort.abort(); clearInterval(timer); }; },[refresh]);
  useEffect(() => { if (!selected) { setEvents([]); return; } const abort = new AbortController();
    void request<{ events: JobEvent[] }>(`/jobs/${selected}`,undefined,abort.signal).then((data) => setEvents(data.events)).catch(() => {});
    return () => abort.abort(); },[selected,workspace]);
  const job = workspace?.jobs.find((j) => j.id === selected);
  const act = async (action: string, extra: Record<string,unknown> = {}) => {
    if (!job) return; setPending(true); setError("");
    try { const updated = await request<Job>(`/jobs/${job.id}/action`,{ action, ...extra });
      if (action === "correct" || action === "review") setSelected(updated.id); setCorrection(""); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "Operation failed"); } finally { setPending(false); }
  };
  const saveRepo = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); setPending(true); setError("");
    try { await request<Repository>("/repositories",{ slug: String(data.get("slug")), environmentId: String(data.get("environmentId")), environments: String(data.get("claudeRoutineId") || "").trim() ? { "claude-cloud": String(data.get("claudeRoutineId")).trim() } : {}, baseRef: String(data.get("baseRef")), generation: String(data.get("generation")), publish: true, merge: data.get("merge") === "on", behavioralChecks: String(data.get("behavioralChecks") || "").split(",").map(s => s.trim()).filter(Boolean), verification: JSON.parse(String(data.get("verification") || "[]")) });
      setModal(null); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : "Could not save repository"); } finally { setPending(false); }
  };
  const delegate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); setPending(true); setError("");
    try { const created = await request<Job>("/jobs",{ requestKey: delegationKey.current, repository: data.get("repository"), title: data.get("title"), brief: data.get("brief"), standingInstructions: data.get("standingInstructions"),
      writeScopes: String(data.get("writeScopes")).split(",").map((s) => s.trim()).filter(Boolean), profileId: data.get("profileId"), conversationId, botId });
      setSelected(created.id); delegationKey.current = crypto.randomUUID(); setModal(null); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : "Could not delegate work"); } finally { setPending(false); }
  };
  const pair = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); setPending(true);
    try { const result = await request<{ code: string }>("/bridge/pairing",{ roots: String(data.get("roots")).split("\n").map((s) => s.trim()).filter(Boolean), allowAssistance: data.get("assist") === "on" }); setPairCode(result.code); }
    catch (err) { setError(err instanceof Error ? err.message : "Pairing failed"); } finally { setPending(false); }
  };
  const hasRepositories = Boolean(workspace?.repositories.length);
  return <main className="flex min-w-0 flex-1 flex-col overflow-auto bg-app" aria-label="later.dog workspace">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-5 md:px-9">
      <div><h1 className="text-[20px] font-semibold tracking-tight">Cloud jobs</h1><p className="mt-0.5 text-[13px] text-ink-secondary">Work your dogs hand to Codex Cloud. Each job ends as a draft pull request that CI checks before you merge it.</p></div>
      <div className="flex flex-wrap gap-2"><button className={secondaryButton} onClick={() => setModal("repo")}><GitHubLogoIcon />Repository</button><button className={primaryButton} disabled={!hasRepositories} onClick={() => setModal("job")}><PlusIcon />Delegate work</button></div>
    </header>
    <div className="px-6 py-7 md:px-9">
      <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-xs font-medium uppercase tracking-[.16em] text-ink-secondary">Your cloud workspace</p><h2 className="mt-2 text-2xl font-semibold tracking-tight">Keep the work moving.</h2><p className="mt-2 max-w-xl text-sm leading-6 text-ink-secondary">Talk to your agents in chat. Follow the work here, wherever it runs.</p></div>
        <button className={secondaryButton} onClick={() => { setPairCode(""); setModal("pair"); }}><GlobeIcon />Pair this computer</button></div>
      {error && !modal && <div role="alert" className="mt-5 flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm"><ExclamationTriangleIcon className="mt-0.5 shrink-0 text-danger" /><span className="flex-1">{error}</span><button aria-label="Retry workspace connection" onClick={() => void refresh()}><ReloadIcon /></button></div>}
      {!workspace && !error && <div aria-label="Loading workspace" className="mt-8 space-y-3">{[0,1,2].map((i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-raised" />)}</div>}
      {workspace && <>
        <dl className="mt-7 grid grid-cols-2 gap-y-5 border-y border-border py-5 sm:grid-cols-4">
          {[ ["Active cloud jobs",`${workspace.active} / ${workspace.concurrency}`], ["PRs opened",workspace.metrics.prOpened], ["PRs verified",workspace.metrics.verified], ["PRs merged",workspace.metrics.merged] ].map(([label,value]) => <div key={label} className="pr-5"><dt className="text-xs text-ink-secondary">{label}</dt><dd className="mt-1 font-mono text-xl font-medium">{value}</dd></div>)}
        </dl>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-ink-secondary"><span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-accent" />{workspace.backends.filter((b) => b.enabled).map((b) => b.label).join(" · ") || "No execution backend"} · polled activity</span><span>Publishing host: {workspace.publishingHost}</span><span>Agent wakeups: {workspace.wakeupsConfigured ? "configured" : "not configured"}</span><span title={github?.detail} className="flex items-center gap-2">GitHub: {github === null ? "not checked" : github.authenticated ? `${github.login} via ${github.source}`
          : signingIn && github.signIn?.code ? <>enter <button type="button" title="Copy the code" onClick={() => void copyText(github.signIn!.code!)} className="rounded bg-raised px-1.5 py-0.5 font-mono text-ink">{github.signIn.code}</button> at <a href={github.signIn.url} target="_blank" rel="noreferrer" className="text-accent underline">github.com/login/device</a>, then Authorize</>
          : <>not connected <button type="button" onClick={() => void connectGitHub()} className="rounded-md border border-border px-2 py-0.5 text-ink hover:bg-raised">Connect GitHub</button></>}
          {github?.signIn?.phase === "failed" && !github.authenticated && <span className="text-danger">{github.signIn.detail}</span>}</span></div>
        {!workspace.jobs.length ? <section className="mt-8 rounded-2xl border border-border bg-panel px-6 py-10"><div className="max-w-lg"><p className="text-xs font-medium uppercase tracking-[.16em] text-ink-secondary">Start with one real change</p><h3 className="mt-3 text-xl font-semibold tracking-tight">Give an agent a repo and a goal.</h3><p className="mt-3 text-sm leading-6 text-ink-secondary">Connect a published Codex Cloud environment, then delegate work here or through your agent’s later.dog tools. Each task keeps its own branch and evidence.</p><button className={`${primaryButton} mt-6`} onClick={() => setModal(hasRepositories ? "job" : "repo")}>{hasRepositories ? "Delegate your first task" : "Connect a repository"}<ArrowRightIcon /></button></div></section>
          : <div className={`mt-7 grid items-start gap-7 ${job ? "xl:grid-cols-[minmax(0,1fr)_minmax(320px,.8fr)]" : "grid-cols-1"}`}>
            <section aria-label="Delegated jobs" className="overflow-hidden rounded-xl border border-border bg-panel"><div className="flex items-center justify-between border-b border-border px-5 py-3"><h3 className="text-sm font-medium">Delegated work</h3><span className="text-xs text-ink-secondary">{workspace.jobs.length} jobs</span></div>
              <div className="divide-y divide-border">{workspace.jobs.map((item) => <button key={item.id} onClick={() => setSelected(item.id)} aria-pressed={selected === item.id} className={`w-full px-5 py-4 text-left transition-colors hover:bg-raised/60 ${selected === item.id ? "bg-raised" : ""}`}><div className="flex items-start justify-between gap-3"><span className="text-sm font-medium">{item.title}</span><span className={`shrink-0 rounded-md px-2 py-1 text-[11px] ${["needs_attention","submission_unknown"].includes(item.state) ? "bg-danger/10 text-danger" : "bg-app text-ink-secondary"}`}>{labels[item.state]}</span></div><div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-secondary"><span>{item.repository}</span><span>{item.kind} · run {item.attempt}</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString(undefined,{ month: "short",day: "numeric",hour: "numeric",minute: "2-digit" })}</time></div></button>)}</div>
            </section>
            {job && <aside aria-label="Job details" className="rounded-xl border border-border bg-panel p-5"><div className="flex items-start justify-between gap-3"><h3 className="font-semibold">{job.title}</h3><button aria-label="Close job details" onClick={() => setSelected(null)}><Cross2Icon /></button></div><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink-secondary">{job.brief}</p>
              {job.blocker && <p className="mt-4 rounded-lg border border-danger/25 p-3 text-sm text-danger">{job.blocker}</p>}
              <dl className="mt-5 space-y-3 text-xs"><div><dt className="text-ink-secondary">Output branch</dt><dd className="mt-1 break-all font-mono">{job.outputBranch}</dd></div>{job.headSha && <div><dt className="text-ink-secondary">PR commit</dt><dd className="mt-1 break-all font-mono">{job.headSha}</dd></div>}<div><dt className="text-ink-secondary">Write scopes</dt><dd className="mt-1 font-mono">{job.writeScopes.join(", ")}</dd></div></dl>
              <div className="mt-5 flex flex-wrap gap-2">{job.taskUrl && <a href={job.taskUrl} target="_blank" rel="noreferrer" className={secondaryButton}>Cloud task<ArrowRightIcon /></a>}{job.prUrl && <a href={job.prUrl} target="_blank" rel="noreferrer" className={secondaryButton}>Pull request<ArrowRightIcon /></a>}{job.conversationId && openConversation && <button className={secondaryButton} onClick={() => openConversation(job)}>Conversation</button>}</div>
              <div className="mt-5 flex flex-wrap gap-2"><button className={secondaryButton} disabled={pending || !["ready","needs_attention"].includes(job.state) || !job.patchArtifact || job.kind === "review" || workspace.publishingHost !== "remote"} onClick={() => void act("publish")}>Publish PR</button><button className={secondaryButton} disabled={pending || !["ready","needs_attention"].includes(job.state) || !job.prUrl || workspace.publishingHost !== "remote"} onClick={() => void act("verify")}>Verify</button><button className={secondaryButton} disabled={pending || !job.prUrl || !job.headSha} onClick={() => void act("review",{ requestKey: crypto.randomUUID() })}>Independent review</button><button className={secondaryButton} disabled={pending || ["merged","cancelled"].includes(job.state)} onClick={() => void act("cancel")}>Cancel request</button></div>
              {job.verification && <p className="mt-4 flex items-center gap-2 text-xs"><CheckCircledIcon />Verification: {job.verification.verdict}{job.verification.headSha !== job.headSha ? " · stale" : " · recorded commit"}</p>}
              {job.review && <p className="mt-3 text-xs text-ink-secondary">Independent review: {job.review.verdict} · {job.review.summary}</p>}
              {workspace.repositories.find((r) => r.slug === job.repository)?.merge && <button className={`${secondaryButton} mt-4`} disabled={pending || job.verification?.verdict !== "passed" || job.review?.verdict !== "pass" || job.state === "merged" || workspace.publishingHost !== "remote"} onClick={() => void act("merge")}>Merge under repository policy</button>}
              {job.state === "submission_unknown" && <form className="mt-5 space-y-3" onSubmit={(e) => { e.preventDefault(); const data = new FormData(e.currentTarget); void act("reconcile",{ taskId: String(data.get("taskId")) }); }}><Field label="Known cloud task ID"><input name="taskId" required placeholder="task_…" className={inputStyle} /></Field><button className={secondaryButton} disabled={pending}>Reconcile without resubmitting</button></form>}
              {job.prUrl && job.state !== "merged" && <form className="mt-5 space-y-3" onSubmit={(e) => { e.preventDefault(); void act("correct",{ brief: correction,requestKey: crypto.randomUUID() }); }}><Field label="Send a correction"><textarea required rows={3} className={inputStyle} value={correction} onChange={(e) => setCorrection(e.target.value)} placeholder="Also handle this edge case…" /></Field><button className={secondaryButton} disabled={pending || !correction.trim()}>Start a repair run<ArrowRightIcon /></button></form>}
              <h4 className="mt-6 border-t border-border pt-4 text-xs font-medium uppercase tracking-wider text-ink-secondary">Receipts</h4><ol className="mt-3 space-y-3">{events.slice(0,12).map((event) => <li key={event.sequence} className="text-xs"><span className="font-medium">{event.type.replaceAll("_"," ")}</span><p className="mt-1 break-words text-ink-secondary">{event.detail}</p></li>)}</ol>
            </aside>}
          </div>}
        {workspace.measurements && <section aria-label="Measured outcomes" className="mt-7 border-t border-border pt-5"><h3 className="text-sm font-medium">Measured outcomes</h3><p className="mt-2 text-xs text-ink-secondary">{workspace.measurements.interventions} interventions · {workspace.measurements.regressions} reported regressions · {workspace.metrics.repairs} repair runs</p><p className="mt-2 text-xs text-ink-secondary">Model cost: {workspace.measurements.reportedModelCostUsd === null ? "unknown" : `$${workspace.measurements.reportedModelCostUsd.toFixed(2)}`} · Compute cost: {workspace.measurements.reportedComputeCostUsd === null ? "unknown" : `$${workspace.measurements.reportedComputeCostUsd.toFixed(2)}`}</p></section>}
        <section aria-label="Execution backends" className="mt-7 border-t border-border pt-5"><h3 className="text-sm font-medium">Execution backends</h3><div className="mt-3 space-y-3">{workspace.backends.map(backend => <div key={backend.id} className="text-xs"><span className="font-medium">{backend.label} · {backend.enabled ? "adapter available" : "not qualified"}</span><p className="mt-1 max-w-2xl text-ink-secondary">{backend.limitation}</p></div>)}</div></section>
        <section className="mt-8 border-t border-border pt-5 text-xs leading-5 text-ink-secondary"><p>Free, open-source software. Your provider allowance applies. Cloudflare and other paid compute require a separately configured budget.</p><p className="mt-1">2,500 PRs a month is a capacity target. This workspace reports observed results.</p></section>
      </>}
    </div>
    {modal === "repo" && <Dialog error={error} title="Connect a repository" close={() => setModal(null)}><form onSubmit={(e) => void saveRepo(e)} className="space-y-4 p-6"><Field label="GitHub repository"><input name="slug" className={inputStyle} required placeholder="owner/repository" list="laterdog-repositories" /><datalist id="laterdog-repositories">{workspace?.repositories.map((r) => <option key={r.slug} value={r.slug} />)}</datalist></Field><Field label="Published Codex Cloud environment ID"><input name="environmentId" className={inputStyle} required /></Field><Field label="Claude routine ID for claude-cloud profiles (optional)"><input name="claudeRoutineId" className={inputStyle} placeholder="trig_…" /></Field><div className="grid grid-cols-2 gap-4"><Field label="Starting branch"><input name="baseRef" className={inputStyle} defaultValue="main" required /></Field><Field label="Environment generation"><select name="generation" className={inputStyle}><option value="unqualified">Not qualified yet</option><option value="current">Current cloud</option><option value="legacy">Legacy cloud</option></select></Field></div><Field label="Behavioral CI check names, separated by commas"><input name="behavioralChecks" className={inputStyle} placeholder="integration-tests, browser-acceptance" /></Field><Field label="Verification commands as JSON arrays (optional)"><textarea name="verification" rows={2} className={inputStyle} defaultValue="[]" placeholder='[ ["pnpm", "test"] ]' /></Field><label className="flex items-start gap-2 text-sm"><input name="merge" type="checkbox" className="mt-1" /><span>Grant agents merge authority after current-commit checks and independent review.</span></label><p className="text-xs leading-5 text-ink-secondary">Environment setup happens in Codex desktop or web. This connects an existing setup; it does not provision a VM.</p><button className={primaryButton} disabled={pending}>Connect repository</button></form></Dialog>}
    {modal === "job" && <Dialog error={error} title="Delegate cloud work" close={() => setModal(null)}><form onSubmit={(e) => void delegate(e)} className="space-y-4 p-6"><div className="grid grid-cols-2 gap-4"><Field label="Repository"><select name="repository" className={inputStyle}>{workspace?.repositories.map((r) => <option key={r.slug}>{r.slug}</option>)}</select></Field><Field label="Account profile"><select name="profileId" className={inputStyle}>{workspace?.profiles.map((p) => <option value={p.id} key={p.id}>{p.label}</option>)}</select></Field></div><Field label="Task title"><input name="title" className={inputStyle} required /></Field><Field label="Goal and acceptance criteria"><textarea name="brief" rows={5} className={inputStyle} required /></Field><Field label="Write scopes, separated by commas"><input name="writeScopes" className={inputStyle} defaultValue="*" required /></Field><Field label="Standing instructions"><textarea name="standingInstructions" rows={2} className={inputStyle} defaultValue="Use pnpm. Prove the real behavior and preserve evidence." /></Field><button className={primaryButton} disabled={pending}>Delegate cloud work<ArrowRightIcon /></button></form></Dialog>}
    {modal === "pair" && <Dialog error={error} title="Pair a local computer" close={() => setModal(null)}><form onSubmit={(e) => void pair(e)} className="space-y-4 p-6"><Field label="Allowed absolute repository roots, one per line"><textarea name="roots" rows={3} required className={inputStyle} placeholder="/Users/you/code/project" /></Field><label className="flex items-start gap-2 text-sm"><input name="assist" type="checkbox" className="mt-1" /><span>Allow assistance through a configured local dog and its existing computer permissions.</span></label><p className="text-xs leading-5 text-ink-secondary">The bridge connects outbound. Requests wait while your computer is offline.</p><button className={primaryButton} disabled={pending}>Create pairing code</button>{pairCode && <div className="space-y-3 rounded-lg border border-border p-4"><p className="text-xs">Single use · expires in five minutes. Save this code to a private file, then pair the bridge using the documented command.</p><code className="block break-all text-sm">{pairCode}</code><button type="button" className={secondaryButton} onClick={() => void copyText(pairCode)}>Copy pairing code</button></div>}</form></Dialog>}
  </main>;
}
