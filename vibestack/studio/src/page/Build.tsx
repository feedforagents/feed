// Where the project stands, and what can be done about it now: top pipeline bar, activity drawer, command palette,
// and publish/review dialogs. Every control is offered exactly when the session allows its event (spec/index.md).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Dialog, DialogClose, DialogContent, DialogTitle, Input, Skeleton, Spinner, cn, focusRing } from "@repo/ui";
import { headingsAreSound } from "../../gen/outline.ts";
import { SIGN, edits, nodesOfOutline } from "../markdown.ts";
import type { JobView } from "../project.ts";
import {
  S, can, dirtySpecs, discard, failing, graphOf, isDarkTheme, locate, openComponent, openStateFocus, publish,
  publishedText, reveal, select, setCmdOpen, setDensity, setDrawer, setView, specLabel, stagesOf, start, toast,
  toggleRail, toggleTheme, type StageMark, type StudioView,
} from "./studio.ts";
import { Code, Dot, Icon, IconButton, Markdown, Quint, Tooltip, type IconName } from "./text.tsx";

const elapsed = (job: JobView, now: number) => { const s = Math.round(((job.finished ?? now) - job.started) / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
/** A running job's time, ticking. */
function Elapsed({ job }: { job: JobView }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (job.status !== "running") return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [job.status]);
  return <span className="text-xs text-muted-foreground tabular-nums">{elapsed(job, now)}</span>;
}

type StageState = "idle" | "todo" | "active" | "running" | "ok" | "bad";
const NODE: Record<Exclude<StageState, "running">, string> = {
  idle: "border-border", todo: "border-warn text-warn", active: "border-primary bg-primary text-primary-foreground",
  ok: "border-ok bg-ok text-card", bad: "border-destructive bg-destructive text-card",
};
const PIPELINE_DOT: Record<Exclude<StageState, "running">, string> = {
  idle: "bg-border", todo: "bg-warn", active: "bg-primary", ok: "bg-ok", bad: "bg-destructive",
};
const PIPELINE_TEXT: Record<StageState, string> = {
  idle: "text-muted-foreground", todo: "text-warn", active: "text-primary font-medium",
  running: "text-primary font-medium", ok: "text-ok", bad: "text-destructive font-medium",
};

const Stage = ({ name, state, mark, label }: { name: string; state: StageState; mark: string | number; label: string }) => (
  <div className="relative flex flex-col items-center gap-1.5 text-xs text-muted-foreground">
    {state === "running" ? <Spinner label={`${name}: running`} className="rounded-full bg-card text-primary" />
      : <div role="img" aria-label={`${name}: ${label}`} title={label} className={cn("grid size-6 place-items-center rounded-full border-2 bg-card text-xs font-bold tabular-nums", NODE[state])}>{mark}</div>}
    {name}
  </div>
);

const MARK: Record<Exclude<StageMark, "running">, [string, string]> = { passed: ["✓", "text-ok"], failed: ["✗", "text-destructive"], skipped: ["–", "text-muted-foreground"], "": ["·", "text-muted-foreground"] };
/** The stages of the last check, or the one running, as one row of marks. */
const Stages = ({ running }: { running: boolean }) => (
  <ol aria-label="Stages" className="m-0 flex list-none flex-wrap gap-x-2.5 gap-y-1 p-0 text-xs text-muted-foreground">
    {stagesOf(S.snap?.check?.results ?? [], running).map(({ stage, mark, simulated }) => {
      const label = `${stage}: ${mark || "not run"}${simulated ? `, ${simulated} obligations simulated only` : ""}`;
      return (
        <li key={stage} title={label} aria-label={label} className="flex items-center gap-1">
          {mark === "running" ? <Spinner size="sm" label={`${stage}: running`} className="size-3 text-primary" /> : <span aria-hidden className={cn("font-mono font-semibold", MARK[mark][1])}>{MARK[mark][0]}</span>}
          {stage}{simulated > 0 && <span className="text-warn tabular-nums">{simulated}</span>}
        </li>
      );
    })}
  </ol>
);

/** Line diff (../markdown.ts, `edits`), with three lines of context around each change. */
function diff(a: string, b: string) {
  const ops = edits(a.split("\n"), b.split("\n"));
  const near = ops.map((_, k) => ops.slice(Math.max(0, k - 3), k + 4).some(({ op }) => op !== " "));
  return ops.flatMap(({ op, item, at }, k) => near[k] ? [<div key={at} className={cn("px-2.5 whitespace-pre-wrap", op === "+" && "bg-ok/15", op === "-" && "bg-destructive/15")}>{`${op} ${item}`}</div>]
    : near[k - 1] || k === 0 ? [<div key={at} className="bg-muted px-2.5 text-muted-foreground">…</div>] : []);
}

/** A question before acting: what will happen, a way out, and the one action. `wide` for what needs reading. */
export function Ask({ open, onOpenChange, title, action, disabled = false, wide = false, onConfirm, children }:
  { open: boolean; onOpenChange: (open: boolean) => void; title: string; action: ReactNode; disabled?: boolean; wide?: boolean; onConfirm: () => void; children?: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("max-h-[86vh] gap-0 p-0", wide && "max-w-230")}>
        <DialogTitle className="px-6 py-4 pr-12 leading-normal">{title}</DialogTitle>
        {children ? <div className="flex flex-col gap-4 overflow-auto border-t border-border px-6 py-4">{children}</div> : null}
        <div className="flex justify-end gap-2 border-t border-border px-6 py-3">
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button disabled={disabled} onClick={() => { onOpenChange(false); onConfirm(); }}>{action}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** What publishing writes: each changed spec's diff. Refused while a spec has a heading that is empty or not unique. */
export function PublishDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const dirty = dirtySpecs();
  const unsound = dirty.filter((s) => !s.deleted && !headingsAreSound(s.outline)).map((s) => s.file);
  return (
    <Ask wide open={open} onOpenChange={onOpenChange} title={`Publish ${dirty.length === 1 ? dirty[0].file : `${dirty.length} specs`}`}
      action={<><Icon name="check" />Publish</>} disabled={unsound.length > 0} onConfirm={() => void publish()}>
      {unsound.length > 0 && <Alert variant="destructive">{unsound.join(", ")}</Alert>}
      {dirty.map((spec) => (
        <div key={spec.file} className="overflow-auto rounded-md border border-border font-mono text-xs leading-normal">
          <div className="border-b border-border bg-muted px-2.5 py-1.5 font-semibold">{spec.deleted ? `${spec.file} (deleted)` : spec.orig === null ? `${spec.file} (new)` : spec.file}</div>
          {!spec.deleted && diff(spec.orig ?? "", publishedText(spec)!)}
        </div>
      ))}
    </Ask>
  );
}

/** Everything a sign-off records, to read before it does (spec/index.md, "Story: Sign off"). */
function ReviewDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const review = S.snap?.review ?? [];
  return (
    <Ask wide open={open} onOpenChange={onOpenChange} title={`Sign off ${review.length}`}
      action={<><Icon name="check" />Sign off</>} disabled={!can({ type: "signOff" })} onConfirm={() => start("accept")}>
      {review.map((r) => (
        <section key={r.where} aria-label={r.where} className="flex flex-col gap-2">
          <h3 className="font-semibold">{r.where.replace(/^.*  (## )?/, "")} <span className="font-normal text-warn">{r.status}</span></h3>
          {r.prose && <Markdown text={r.prose} file={r.file ?? ""} className="text-muted-foreground" />}
          {r.quint && <Quint code={r.quint} />}
        </section>
      ))}
    </Ask>
  );
}

interface PipelineStep { name: string; state: StageState; count: number; label: string }

function pipelineSteps(): PipelineStep[] {
  const snap = S.snap;
  const dirty = dirtySpecs().length;
  if (!snap) return [];
  const { job: running, verdict, waiting } = snap.session;
  const blocking = failing(snap.check?.results).length;
  const review = snap.review.length;
  return [
    { name: "Edit", state: dirty ? "active" : "idle", count: dirty, label: dirty ? `${dirty} specs changed` : "nothing unpublished" },
    { name: "Publish", state: dirty ? "todo" : waiting ? "ok" : "idle", count: 0, label: dirty ? "waiting to publish" : waiting ? "published" : "nothing to publish" },
    { name: "Sync", state: running === "Syncing" ? "running" : waiting ? "todo" : "ok", count: waiting, label: waiting ? `${waiting} changes for the agent` : "in step" },
    {
      name: "Check",
      state: running === "Checking" ? "running" : verdict === "Unknown" ? "idle" : verdict === "Failing" ? "bad" : "ok",
      count: blocking,
      label: { Unknown: "not checked since the specs changed", Failing: `${blocking} failing`, Reviewable: "only review left", Green: "all green" }[verdict],
    },
    { name: "Sign off", state: running === "SigningOff" ? "running" : review ? "todo" : verdict === "Green" ? "ok" : "idle", count: review, label: review ? `${review} to review` : "nothing to review" },
  ];
}

const MODES: { id: StudioView; label: string; icon: IconName; needsComponents?: boolean }[] = [
  { id: "specs", label: "Stories", icon: "stories" },
  { id: "states", label: "States", icon: "graph" },
  { id: "components", label: "Layout", icon: "layout", needsComponents: true },
  { id: "split", label: "Split", icon: "split", needsComponents: true },
];

function pipelineHeadline(steps: PipelineStep[]): { text: string; state: StageState } {
  const running = steps.find((s) => s.state === "running");
  if (running) return { text: `${running.name}…`, state: "running" };
  const bad = steps.find((s) => s.state === "bad");
  if (bad) return { text: bad.label, state: "bad" };
  const active = steps.find((s) => s.state === "active");
  if (active) return { text: active.label, state: "active" };
  const todo = steps.find((s) => s.state === "todo" && s.count > 0);
  if (todo) return { text: todo.label, state: "todo" };
  const check = steps.find((s) => s.name === "Check");
  if (check?.state === "ok") return { text: "All green", state: "ok" };
  return { text: "In step", state: "idle" };
}

/** The 48px Top Bar: sidebar toggle, project switcher, active lens switcher, compact 5-dot status stepper, and icon actions. */
export function TopBar({ onPublish }: { onPublish: () => void }) {
  const snap = S.snap;
  const [asking, setAsking] = useState<"discard" | "review">();
  const dirty = dirtySpecs();
  const steps = pipelineSteps();
  const review = snap?.review.length ?? 0;
  const running = snap?.session.job && snap.session.job !== "Idle";
  const hasComponents = !!S.components;
  const dark = isDarkTheme();
  const activeProject = S.projects.find((p) => p.id === S.project)?.name ?? snap?.project.name ?? "Vibestack Studio";
  const blocking = failing(snap?.check?.results).length;
  const visibleModes = MODES.filter((m) => !m.needsComponents || hasComponents);
  const headline = steps.length ? pipelineHeadline(steps) : undefined;
  const statusMark = blocking ? "bad" : snap?.session.waiting ? "review" : snap?.session.previewing ? "ok" : "";

  return (
    <header className="flex h-12 flex-none items-center justify-between gap-2 border-b border-border bg-card px-3">
      <div className="flex min-w-0 items-center gap-2">
        <IconButton
          name="sidebar"
          label={S.railCollapsed ? "Show sidebar" : "Hide sidebar"}
          shortcut="⌘\"
          align="left"
          active={!S.railCollapsed}
          onClick={toggleRail}
        />
        <div className="flex items-center gap-2">
          <span aria-hidden className="grid size-6 flex-none place-items-center rounded-sm bg-primary text-xs font-bold text-primary-foreground">S</span>
          {S.projects.length > 1 ? (
            <select aria-label="Project" value={S.project}
              onChange={(e) => { location.search = `?project=${encodeURIComponent(e.target.value)}`; }}
              className={cn(focusRing, "max-w-36 truncate rounded-md border border-transparent bg-transparent py-1 pr-2 text-sm font-semibold text-foreground hover:bg-accent")}>
              {S.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          ) : (
            <span className="max-w-36 truncate text-sm font-semibold">{activeProject}</span>
          )}
        </div>
        <span aria-hidden className="h-4 w-px bg-border" />
        <div role="tablist" aria-label="Workspace mode" className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
          {visibleModes.map((m) => {
            const active = S.view === m.id;
            return (
              <button key={m.id} type="button" role="tab" aria-selected={active}
                onClick={() => setView(m.id)}
                className={cn(focusRing, "flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors duration-fast",
                  active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                <Icon name={m.icon} className="size-3.5" />
                <span>{m.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {steps.length > 0 && headline && (
        <Tooltip label={steps.map((st) => `${st.name}: ${st.label}`).join(" · ")}>
          <button type="button" aria-label="Session pipeline" aria-expanded={S.drawer} onClick={() => setDrawer(!S.drawer)}
            className={cn(focusRing, "hidden items-center gap-2 rounded-full border border-border/70 bg-background/60 px-2.5 py-1 text-xs transition-colors duration-fast hover:bg-accent lg:flex")}>
            <span aria-hidden className="flex items-center gap-1">
              {steps.map((st) => (
                st.state === "running"
                  ? <Spinner key={st.name} size="sm" label={`${st.name}: running`} className="size-2.5 text-primary" />
                  : <span key={st.name} className={cn("size-1.5 rounded-full transition-colors duration-fast", PIPELINE_DOT[st.state])} />
              ))}
            </span>
            <span className={cn("text-xs", PIPELINE_TEXT[headline.state])}>{headline.text}</span>
          </button>
        </Tooltip>
      )}

      <div className="flex flex-none items-center gap-1">
        {S.view === "specs" && (
          <IconButton
            name="code"
            label={S.density === "quint" ? "Hide Quint blocks (Prose only)" : "Show Quint blocks"}
            active={S.density === "quint"}
            onClick={() => setDensity(S.density === "quint" ? "prose" : "quint")}
          />
        )}
        <IconButton name={dark ? "sun" : "moon"} label={dark ? "Switch to light theme" : "Switch to dark theme"} onClick={toggleTheme} />
        <Tooltip label={snap?.session.job === "Checking" ? "Checking…" : "Run check"}>
          <Button variant="ghost" size="icon" aria-label="Run check" disabled={!can({ type: "check" })}
            className="size-7 text-muted-foreground hover:text-foreground" onClick={() => start("check")}>
            {snap?.session.job === "Checking" ? <Spinner size="sm" label="Checking" className="size-3.5 text-primary" /> : <Icon name="play" className="size-3.5" />}
          </Button>
        </Tooltip>
        <Tooltip label={snap?.app.script ? "App & activity" : "Build & activity"} align={dirty.length === 0 && review === 0 ? "right" : "center"}>
          <Button variant={S.drawer ? "secondary" : "ghost"} size="icon" aria-label={snap?.app.script ? "App" : "Build"} aria-expanded={S.drawer}
            className={cn("relative size-7 text-muted-foreground hover:text-foreground", S.drawer && "text-primary")}
            onClick={() => setDrawer(!S.drawer)}>
            {running ? <Spinner size="sm" label="Job running" className="size-3.5 text-primary" /> : <Icon name="activity" className="size-3.5" />}
            {!running && statusMark && (
              <span aria-hidden className={cn("absolute top-1 right-1 size-1.5 rounded-full", statusMark === "bad" ? "bg-destructive" : statusMark === "review" ? "bg-warn" : "bg-ok")} />
            )}
          </Button>
        </Tooltip>
        {can({ type: "discard" }) && (
          <IconButton name="undo" label="Discard changes" danger onClick={() => setAsking("discard")} />
        )}
        {review > 0 && (
          <Button variant="outline" size="sm" className="h-7 border-warn px-2 text-xs text-warn hover:bg-warn/10 hover:text-warn" onClick={() => setAsking("review")}>
            <Icon name="check" className="size-3.5" />Review {review}
          </Button>
        )}
        {dirty.length > 0 ? (
          <Tooltip label="Publish changes" shortcut="⌘S" align="right">
            <Button variant="primary" size="sm" className="h-7 px-2.5 text-xs" disabled={!can({ type: "publish", changes: 0 })} onClick={onPublish}>
              <Icon name="check" className="size-3.5" />Publish {dirty.length}
            </Button>
          </Tooltip>
        ) : (
          <IconButton name="check" label="Publish" shortcut="⌘S" align="right" disabled onClick={onPublish} />
        )}
      </div>

      <Ask open={asking === "discard"} onOpenChange={() => setAsking(undefined)} title={`Discard changes to ${dirty.map((s) => s.file).join(", ")}`} action="Discard" onConfirm={discard} />
      <ReviewDialog open={asking === "review"} onOpenChange={() => setAsking(undefined)} />
    </header>
  );
}

/** On-demand right Activity Drawer holding Build, Sync, Check stages, App controls, and live Job logs. */
export function BuildDrawer() {
  const logRef = useRef<HTMLPreElement>(null);
  const snap = S.snap;
  const [reviewOpen, setReviewOpen] = useState(false);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; });
  if (!S.drawer) return null;
  if (!snap) {
    return (
      <aside aria-label="Build" className="fixed top-12 right-0 bottom-0 z-30 flex w-90 max-w-[92vw] flex-col gap-4 border-l border-border bg-card p-4 shadow-lg">
        <Skeleton className="h-10" /><Skeleton className="h-9 w-1/2" /><Skeleton className="h-24" />
      </aside>
    );
  }
  const { job: running } = snap.session;
  const { jobs, check, manifest } = snap;
  const job = [jobs.agent, jobs.accept, jobs.build].filter((j): j is JobView => !!j).sort((a, b) => b.started - a.started)[0];
  const blocking = failing(check?.results);
  const review = snap.review.length;
  const steps = pipelineSteps();
  const copyPrompt = () => { navigator.clipboard.writeText(snap.prompt).then(() => toast("Sync prompt copied"), () => toast("Could not copy")); };

  return (
    <aside aria-label="Build" className="fixed top-12 right-0 bottom-0 z-30 flex w-90 max-w-[92vw] flex-col gap-5 overflow-auto border-l border-border bg-card p-4 shadow-lg">
      <div className="flex items-center justify-between border-b border-border pb-2.5">
        <span className="text-sm font-semibold">Activity</span>
        <IconButton name="close" label="Close activity drawer" onClick={() => setDrawer(false)} />
      </div>

      <div aria-label="Where the project stands" className="relative grid grid-cols-5 before:absolute before:inset-x-[10%] before:top-2.75 before:h-0.5 before:bg-border">
        {steps.map((st) => <Stage key={st.name} name={st.name} state={st.state} mark={st.count || ""} label={st.label} />)}
      </div>

      {manifest && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Waiting for sync</span>
            <Button variant="outline" size="sm" disabled={!can({ type: "markSynced" })} onClick={() => start("synced")}><Icon name="check" />Mark synced</Button>
          </div>
          <ul className="m-0 flex max-h-52 list-none flex-col gap-1 overflow-auto rounded-md border border-border bg-background p-2 text-sm">
            {manifest.changes.map((c) => (
              <li key={`${c.action} ${c.kind} ${c.key}`} className="grid grid-cols-[14px_1fr] gap-1.5">
                <span aria-label={c.action} className={cn("font-mono font-semibold", c.action === "added" ? "text-ok" : c.action === "deleted" ? "text-destructive" : "text-warn")}>{SIGN[c.action]}</span>
                <span>{c.kind === "spec" ? c.key : c.key.replace(/^## /, "").replace(/^Story: /, "")}
                  {c.what.length > 0 && <div className="text-xs text-muted-foreground">{c.what.join(" · ")}</div>}</span>
              </li>
            ))}
          </ul>
          {manifest.regenerate.length > 0 && <div className="text-xs text-muted-foreground">↻ {manifest.regenerate.map((r) => r.gen).join(", ")}</div>}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">Sync agents</span>
          <IconButton name="copy" label="Copy sync prompt" align="right" onClick={copyPrompt} />
        </div>
        {snap.agents.map((a) => (
          <div key={a.id} className="flex items-center gap-1.5">
            <span className="flex-1 text-sm font-medium">{a.label}</span>
            <IconButton name="play" label={a.available ? `Run ${a.label}` : `${a.label} is not installed`} disabled={!a.available || !can({ type: "sync" })} align="right" onClick={() => start("agent", { agent: a.id })} />
            {a.link && (
              <Tooltip label={`Open ${a.label}`} align="right">
                <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground" asChild>
                  <a href={a.link} aria-label={`Open ${a.label}`}><Icon name="open" className="size-3.5" /></a>
                </Button>
              </Tooltip>
            )}
          </div>
        ))}
      </div>

      {(snap.app.script || snap.app.buildable) && (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <div className="flex items-center gap-1.5">
            <Dot mark={snap.session.previewing ? "ok" : ""} label={snap.session.previewing ? "running" : "stopped"} />
            <span className="flex-1 truncate text-sm font-semibold">App {snap.app.script && <span className="font-mono text-xs font-normal text-muted-foreground">pnpm {snap.app.script}</span>}</span>
            {snap.session.previewing && snap.app.url && (
              <Tooltip label="Open app in browser" align="right">
                <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground" asChild>
                  <a href={snap.app.url} target="_blank" rel="noreferrer" aria-label="Open app"><Icon name="open" className="size-3.5" /></a>
                </Button>
              </Tooltip>
            )}
            {snap.app.buildable && <IconButton name="check" label="Build app" disabled={!can({ type: "build" })} align="right" onClick={() => start("build")} />}
            {snap.app.script && can({ type: "preview" }) && <IconButton name="play" label="Start app" align="right" onClick={() => start("app", { start: true })} />}
            {can({ type: "endPreview" }) && <IconButton name="stop" label="Stop app" align="right" onClick={() => start("app", { start: false })} />}
          </div>
          {snap.app.log.length > 0 && <Code className="max-h-40">{snap.app.log.slice(-40).join("\n")}</Code>}
        </div>
      )}

      {job && (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center gap-2 border-b border-border py-1.5 pr-2 pl-3 text-sm">
            <Dot mark={job.status === "running" ? "dirty" : job.status === "passed" ? "ok" : "bad"} label={job.status} />
            <span className="flex-1 font-semibold">{job.label}</span>
            <Elapsed job={job} />
            {job.status === "running" && can({ type: "stop" }) && <IconButton name="stop" label="Stop" onClick={() => start("stop")} />}
          </div>
          <pre ref={logRef} className="m-0 max-h-64 overflow-auto bg-muted px-3 py-2 font-mono text-xs leading-normal break-words whitespace-pre-wrap">{job.log.join("\n") || "…"}</pre>
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <span className="text-xs font-medium text-muted-foreground">Check</span>
        {check && (
          <div className="flex items-start gap-2">
            <div className="flex-1"><Stages running={running === "Checking"} /></div>
            {jobs.check && <Elapsed job={jobs.check} />}
            {running === "Checking" && <IconButton name="stop" label="Stop" onClick={() => start("stop")} />}
          </div>
        )}
        {jobs.check?.status === "failed" && !check?.finished && (
          <details open className="text-xs"><summary className="cursor-pointer text-destructive">The check did not finish</summary><Code className="mt-1 max-h-65">{jobs.check.log.join("\n")}</Code></details>
        )}
        {check?.next && <div className="text-sm">{check.next}</div>}
        {blocking.map((r) => {
          const at = locate(r);
          return at ? <Button key={`${r.stage} ${r.summary}`} variant="ghost" size="sm" className="h-auto justify-start py-1 text-left text-xs whitespace-normal text-destructive" onClick={() => { setDrawer(false); reveal(at.file, at.key); }}>{r.stage}: {r.summary}</Button>
            : <details key={`${r.stage} ${r.summary}`} className="text-xs"><summary className="cursor-pointer text-destructive">{r.stage}: {r.summary}</summary>{r.detail && <Code className="mt-1 max-h-65">{r.detail}</Code>}</details>;
        })}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="outline" size="sm" disabled={!can({ type: "check" })} onClick={() => start("check")}><Icon name="play" />Run check</Button>
          <Button variant="outline" size="sm" disabled={!review} onClick={() => setReviewOpen(true)}><Icon name="check" />Review</Button>
          {check?.finished !== undefined && <span className="text-xs text-muted-foreground">{new Date(check.finished).toLocaleTimeString()}</span>}
        </div>
      </div>

      <ReviewDialog open={reviewOpen} onOpenChange={setReviewOpen} />
    </aside>
  );
}

interface PaletteItem { id: string; kind: string; title: string; detail: string; run: () => void }

function paletteItems(): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const spec of S.specs) {
    if (spec.deleted) continue;
    const label = specLabel(spec.file);
    out.push({ id: `spec:${spec.file}`, kind: "Spec", title: spec.outline.title || label, detail: spec.file, run: () => select(spec.file) });
    for (const node of nodesOfOutline(spec.file, spec.outline)) {
      const title = (node.rule ?? node.story).title.trim();
      if (!title) continue;
      out.push({
        id: `node:${node.id}`,
        kind: node.rule ? "Rule" : "Story",
        title,
        detail: label,
        run: () => reveal(spec.file, node.key),
      });
    }
    const graph = graphOf(spec.file);
    if (graph) {
      for (const n of graph.nodes) {
        out.push({ id: `state:${spec.file}:${n.id}`, kind: "State", title: n.label, detail: label, run: () => openStateFocus(spec.file, { node: n.id }) });
      }
      const seenEdges = new Set<string>();
      for (const e of graph.edges) {
        if (seenEdges.has(e.name)) continue;
        seenEdges.add(e.name);
        out.push({ id: `edge:${spec.file}:${e.id}`, kind: "Transition", title: e.name, detail: `${e.from} → ${e.to}`, run: () => openStateFocus(spec.file, { edge: e.name }) });
      }
    }
  }
  for (const c of S.components?.components ?? []) {
    out.push({ id: `comp:${c.id}`, kind: "Component", title: c.name, detail: c.model?.spec ?? c.package, run: () => openComponent(c.id) });
  }
  return out;
}

/** ⌘K Jump Palette across specs, stories, rules, states, transitions, and components. */
export function CommandPalette() {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  if (!S.cmdOpen) return null;
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const items = paletteItems().filter((item) => words.every((w) => `${item.kind} ${item.title} ${item.detail}`.toLowerCase().includes(w))).slice(0, 30);
  const active = Math.min(cursor, Math.max(0, items.length - 1));
  const close = () => { setQuery(""); setCursor(0); setCmdOpen(false); };
  const pick = (item: PaletteItem | undefined) => { if (!item) return; close(); item.run(); };

  return (
    <Dialog open={S.cmdOpen} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="max-w-140 gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Jump to</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Icon name="search" className="text-muted-foreground" />
          <Input autoFocus value={query} aria-label="Jump to spec, story, rule, state, or component" placeholder="Jump to spec, story, rule, state, or component…"
            className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
            onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, Math.max(0, items.length - 1))); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); pick(items[active]); }
            }} />
        </div>
        <ul className="m-0 max-h-80 list-none overflow-auto p-1.5">
          {items.length === 0 ? <li className="px-3 py-6 text-center text-sm text-muted-foreground">No matches</li>
            : items.map((item, idx) => (
              <li key={item.id}>
                <button type="button" onClick={() => pick(item)} onMouseEnter={() => setCursor(idx)}
                  className={cn(focusRing, "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm", idx === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50")}>
                  <span className="w-18 flex-none font-mono text-xs text-muted-foreground">{item.kind}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
                  <span className="max-w-36 truncate font-mono text-xs text-muted-foreground">{item.detail}</span>
                </button>
              </li>
            ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
