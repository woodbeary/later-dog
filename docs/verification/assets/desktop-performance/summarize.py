import glob
import json
import os
import statistics
import sys

FOLDER = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))


def dig(value, path):
    for key in path.split("."):
        if value is None:
            return None
        value = value.get(key)
    return value


def sidebar(each):
    return round(each.get("sidebarRows", 0) + each.get("restOfSidebar", 0), 1)


def per(total, times):
    return round(total / times, 1) if times else 0


DEFAULT = [
    ("Open the long chat, median of 8 (ms)", lambda d: dig(d, "timed.switchToLongMs.p50"), "lower"),
    ("Open the long chat, slowest of 8 (ms)", lambda d: dig(d, "timed.switchToLongMs.max"), "lower"),
    ("Long chat: rows drawn when it is first shown", lambda d: max(dig(d, "timed.fill.idle.rowsAtFirstSight") or [0]), "same"),
    ("Long chat: all 120 rows in place, median of 8 (ms)", lambda d: dig(d, "timed.fill.idle.filledMs.p50") if dig(d, "timed.fill.idle.filledMs.count") else None, "lower"),
    ("Long chat: openings of 8 that never reached 120 rows", lambda d: dig(d, "timed.fill.idle.unfilled"), "lower"),
    ("Open a short chat, median of 8 (ms)",lambda d: dig(d, "timed.switchToShortMs.p50"), "lower"),
    ("Long tasks across 16 switches (ms)", lambda d: dig(d, "timed.switching.longTaskMs"), "lower"),
    ("Key press to frame, median of 119 keys (ms)", lambda d: dig(d, "timed.typingKeyToFrameMs.p50"), "lower"),
    ("Key press to frame, 95th of 119 keys (ms)", lambda d: dig(d, "timed.typingKeyToFrameMs.p95"), "lower"),
    ("Key press to frame, slowest of 119 keys (ms)", lambda d: dig(d, "timed.typingKeyToFrameMs.max"), "lower"),
    ("Typing: frames slower than 25 ms", lambda d: dig(d, "timed.typing.slowFrames"), "lower"),
    ("Typing: main thread busy over 5.5 s (ms)", lambda d: dig(d, "timed.typing.mainThread.taskMs"), "lower"),
    ("Typing: layouts for 119 keys", lambda d: dig(d, "timed.typing.mainThread.layouts"), "lower"),
    ("Typing: components redrawn for 119 keys", lambda d: dig(d, "counted.typing.rendered"), "lower"),
    ("Cold load: first paint, median of 5 (ms)", lambda d: dig(d, "cold.firstPaintMs.p50"), "lower"),
    ("Cold load: message box ready, median of 5 (ms)", lambda d: dig(d, "cold.composerReadyMs.p50"), "lower"),
    ("Cold load: message box ready, slowest of 5 (ms)", lambda d: dig(d, "cold.composerReadyMs.max"), "lower"),
    ("Idle: main thread busy per 3 s (ms)", lambda d: dig(d, "timed.idle.mainThread.taskMs"), "lower"),
    ("Idle: style passes per 3 s", lambda d: dig(d, "timed.idle.mainThread.styleRecalcs"), "lower"),
    ("A streamed reply: frames slower than 25 ms", lambda d: dig(d, "timed.streaming.slowFrames"), "lower"),
    ("A streamed reply: components redrawn", lambda d: dig(d, "counted.streaming.rendered"), "lower"),
    ("Own bubble after Enter (ms)", lambda d: dig(d, "timed.send.ownBubbleMs"), "lower"),
    ("Four other dogs working: frames slower than 25 ms", lambda d: dig(d, "timed.otherDogsWorking.slowFrames"), "lower"),
    ("Four other dogs working: main thread busy (ms)", lambda d: dig(d, "timed.otherDogsWorking.mainThread.taskMs"), "lower"),
    ("Four other dogs working: components redrawn", lambda d: dig(d, "counted.otherDogsWorking.rendered"), "lower"),
    ("Switching: components redrawn across 16 switches", lambda d: dig(d, "counted.switching.rendered"), "lower"),
    ("JS heap at idle, after a collection (MB)", lambda d: dig(d, "timed.heapIdleMb"), "lower"),
    ("JS heap after the run, after a collection (MB)", lambda d: dig(d, "timed.heapAfterMb"), "lower"),
    ("Page process memory at idle (MB)", lambda d: dig(d, "timed.rendererIdleMb"), "lower"),
    ("Page process memory, highest of 6 samples (MB)", lambda d: dig(d, "timed.rendererPeakMb"), "lower"),
    ("Browser process tree at idle, resident (MB)", lambda d: dig(d, "timed.rssMb.idle.browserTreeRssMb"), "lower"),
    ("Browser process tree, highest in the run, resident (MB)", lambda d: dig(d, "timed.rssMb.peak.browserTreeRssMb"), "lower"),
    ("DOM nodes after the run", lambda d: dig(d, "timed.domNodesAfter"), "lower"),
    ("Rows in the long chat 1.5 s after opening", lambda d: dig(d, "timed.longChatOpened.rows"), "same"),
]

ODS = [
    ("Another dog streams: store changes", lambda d: dig(d, "oneDogStreams.redrawsWhileAnotherDogStreams.storeChanges"), "lower"),
    ("Another dog streams: components redrawn, whole reply", lambda d: dig(d, "oneDogStreams.redrawsWhileAnotherDogStreams.componentsRedrawn"), "lower"),
    ("Another dog streams: components redrawn per store change", lambda d: dig(d, "oneDogStreams.redrawsWhileAnotherDogStreams.eachStoreChange.componentsRedrawn"), "lower"),
    ("Another dog streams: sidebar components redrawn per store change", lambda d: sidebar(dig(d, "oneDogStreams.redrawsWhileAnotherDogStreams.eachStoreChange")), "lower"),
    ("Another dog streams: sidebar rows redrawn per store change", lambda d: dig(d, "oneDogStreams.redrawsWhileAnotherDogStreams.eachStoreChange.sidebarRowsRedrawn"), "lower"),
    ("Another dog streams: most sidebar rows redrawn by one store change", lambda d: dig(d, "oneDogStreams.redrawsWhileAnotherDogStreams.eachStoreChange.mostSidebarRowsRedrawn"), "lower"),
    ("Another dog streams: open chat components redrawn per store change", lambda d: round((dig(d, "oneDogStreams.redrawsWhileAnotherDogStreams.eachStoreChange.restOfOpenChat") or 0) + (dig(d, "oneDogStreams.redrawsWhileAnotherDogStreams.eachStoreChange.openChatTranscript") or 0), 1), "lower"),
    ("Open dog streams: components redrawn, whole reply", lambda d: dig(d, "oneDogStreams.redrawsWhileTheOpenDogStreams.componentsRedrawn"), "lower"),
    ("Open dog streams: components redrawn per store change", lambda d: dig(d, "oneDogStreams.redrawsWhileTheOpenDogStreams.eachStoreChange.componentsRedrawn"), "lower"),
    ("Open dog streams: sidebar components redrawn per store change", lambda d: sidebar(dig(d, "oneDogStreams.redrawsWhileTheOpenDogStreams.eachStoreChange")), "lower"),
    ("Open dog streams: components redrawn each time the reply grew", lambda d: dig(d, "oneDogStreams.redrawsWhileTheOpenDogStreams.eachTimeTheReplyGrew.componentsRedrawn"), "lower"),
    ("Typing, no dog streaming: key to frame, median (ms)", lambda d: dig(d, "oneDogStreams.typingWhileNoDogStreams.keyToFrameMs.p50"), "lower"),
    ("Typing, no dog streaming: key to frame, 95th (ms)", lambda d: dig(d, "oneDogStreams.typingWhileNoDogStreams.keyToFrameMs.p95"), "lower"),
    ("Typing, no dog streaming: frames slower than 25 ms", lambda d: dig(d, "oneDogStreams.typingWhileNoDogStreams.slowFrames"), "lower"),
    ("Typing, no dog streaming: main thread busy (ms)", lambda d: dig(d, "oneDogStreams.typingWhileNoDogStreams.mainThread.taskMs"), "lower"),
    ("Typing, another dog streaming: key to frame, median (ms)", lambda d: dig(d, "oneDogStreams.typingWhileAnotherDogStreams.keyToFrameMs.p50"), "lower"),
    ("Typing, another dog streaming: key to frame, 95th (ms)", lambda d: dig(d, "oneDogStreams.typingWhileAnotherDogStreams.keyToFrameMs.p95"), "lower"),
    ("Typing, another dog streaming: frames slower than 25 ms", lambda d: dig(d, "oneDogStreams.typingWhileAnotherDogStreams.slowFrames"), "lower"),
    ("Typing, another dog streaming: main thread busy (ms)", lambda d: dig(d, "oneDogStreams.typingWhileAnotherDogStreams.mainThread.taskMs"), "lower"),
    ("Typing, open dog streaming: key to frame, median (ms)", lambda d: dig(d, "oneDogStreams.typingWhileTheOpenDogStreams.keyToFrameMs.p50"), "lower"),
    ("Typing, open dog streaming: key to frame, 95th (ms)", lambda d: dig(d, "oneDogStreams.typingWhileTheOpenDogStreams.keyToFrameMs.p95"), "lower"),
    ("Typing, open dog streaming: frames slower than 25 ms", lambda d: dig(d, "oneDogStreams.typingWhileTheOpenDogStreams.slowFrames"), "lower"),
    ("Typing, open dog streaming: main thread busy (ms)", lambda d: dig(d, "oneDogStreams.typingWhileTheOpenDogStreams.mainThread.taskMs"), "lower"),
]

SC = [
    ("Four other dogs take a turn: store changes", lambda d: dig(d, "otherDogsWorking.storeChanges"), "lower"),
    ("Four other dogs take a turn: commits", lambda d: dig(d, "otherDogsWorking.commits"), "lower"),
    ("Four other dogs take a turn: components redrawn", lambda d: dig(d, "otherDogsWorking.rendered"), "lower"),
    ("Four other dogs take a turn: components redrawn per store change", lambda d: per(dig(d, "otherDogsWorking.rendered"), dig(d, "otherDogsWorking.storeChanges")), "lower"),
    ("Idle for 3 s: store changes", lambda d: dig(d, "idle.storeChanges"), "lower"),
    ("Idle for 3 s: components redrawn", lambda d: dig(d, "idle.rendered"), "lower"),
]

KINDS = {"default": DEFAULT, "ods": ODS, "sc": SC}


def load(build, dogs, kind):
    runs = []
    failed = []
    for meta_path in sorted(glob.glob(os.path.join(FOLDER, f"{build}-{dogs}-{kind}-[0-9]*.meta.json"))):
        meta = json.load(open(meta_path))
        stem = meta_path[: -len(".meta.json")]
        if meta["exit"] != 0:
            failed.append(meta["label"])
            continue
        runs.append((meta, json.load(open(stem + ".json"))))
    return runs, failed


def number(value):
    if value is None:
        return "n/a"
    if abs(value) >= 1000:
        return f"{value:,.0f}"
    if float(value).is_integer():
        return f"{value:.0f}"
    return f"{value:.1f}"


def cell(values):
    if not values:
        return "no runs"
    return f"{number(statistics.median(values))} ({number(min(values))} to {number(max(values))})"


def verdict(base, main, better):
    if not base or not main:
        return "not measured"
    if min(base) == max(base) == min(main) == max(main):
        return "same"
    if max(main) < min(base):
        return "changed" if better == "same" else "lower in every run"
    if min(main) > max(base):
        return "changed" if better == "same" else "higher in every run"
    return "no measurable change"


def difference(base, main):
    if not base or not main:
        return "n/a"
    before = statistics.median(base)
    after = statistics.median(main)
    change = after - before
    if change == 0:
        return "0"
    sign = "+" if change > 0 else "-"
    share = f" ({sign}{abs(change) / before * 100:.0f}%)" if before else ""
    return f"{sign}{number(abs(change))}{share}"


def table(kind, dogs, out):
    rows = KINDS[kind]
    base, base_failed = load("base", dogs, kind)
    main, main_failed = load("main", dogs, kind)
    out.append(f"\n{kind} at {dogs} dogs: base {len(base)} runs, main {len(main)} runs" + (f"; failed runs left out: {', '.join(base_failed + main_failed)}" if base_failed or main_failed else ""))
    out.append(f"\n| Measure | base 651cf65, median (range), {len(base)} runs | main 89b1439, median (range), {len(main)} runs | Difference of medians | Verdict |")
    out.append("|---|---|---|---|---|")
    summary = {}
    for name, read, better in rows:
        base_values = [value for value in (read(data) for _, data in base) if value is not None]
        main_values = [value for value in (read(data) for _, data in main) if value is not None]
        result = verdict(base_values, main_values, better)
        out.append(f"| {name} | {cell(base_values)} | {cell(main_values)} | {difference(base_values, main_values)} | {result} |")
        summary[name] = {"base": base_values, "main": main_values, "difference": difference(base_values, main_values), "verdict": result}
    return summary


def layers(out):
    summary = {}
    out.append("\nlayers at 80 dogs")
    out.append("\n| Build | Run | Layers | Layers that draw | Typing 48 keys in the message box as it is |")
    out.append("|---|---|---|---|---|")
    for build in ("base", "main"):
        runs, _ = load(build, 80, "layers")
        for meta, data in runs:
            typing = next((line.split(": ", 1)[1] for line in data.get("typing", []) if line.startswith("message box as it is")), "n/a")
            out.append(f"| {build} | {meta['label']} | {data['layers']} | {data['drawing']} | {typing} |")
            summary[meta["label"]] = {"layers": data["layers"], "drawing": data["drawing"], "why": data.get("why", [])[:6]}
    return summary


def waits(out):
    lines = []
    for meta_path in sorted(glob.glob(os.path.join(FOLDER, "*.meta.json")), key=lambda path: json.load(open(path))["startedAt"]):
        meta = json.load(open(meta_path))
        lines.append(meta)
    out.append("\n| Run | Lock | Waited for the lock (s) | Ran (s) | Load at start (1, 5, 15 min) | Exit |")
    out.append("|---|---|---|---|---|---|")
    for meta in lines:
        out.append(f"| {meta['label']} | {meta['lock']} | {meta['lockWaitSeconds']} | {meta['endedAt'] - meta['startedAt']} | {meta['loadAtStart']} | {meta['exit']} |")


def main():
    out = []
    summary = {}
    for kind in ("default", "ods", "sc"):
        for dogs in (7, 80):
            summary[f"{kind}-{dogs}"] = table(kind, dogs, out)
    summary["layers-80"] = layers(out)
    waits(out)
    print("\n".join(out))
    json.dump(summary, open(os.path.join(FOLDER, "summary.json"), "w"), indent=1)


main()
