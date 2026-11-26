import json
import os
import pathlib
import tempfile
from legacy import (
    LEDGER,
    TASKS,
    digest,
    encode,
    file_bytes,
    hash_name,
    key_for,
    require,
    scopes_for,
    split_entries,
)
from previous_backup import restore_reference, stage_reference
from retention import retain_snapshot
from snapshot import canonical_digest
from transfer import decoded, parallel, read_tree


def write_once(path, value):
    data = encode(value)
    if path.exists():
        require(path.read_bytes() == data, "Recovery journal differs: " + path.name)
        return
    fd, tmp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(tmp, path)
        except FileExistsError:
            require(
                path.read_bytes() == data, "A different migration owns this journal"
            )
    finally:
        pathlib.Path(tmp).unlink(missing_ok=True)


def layout_checksum(layout):
    tasks = [[owner, layout["tasks"][owner]] for owner in sorted(layout["tasks"])]
    loose = layout.get("loose")
    optional = [loose["owner"], loose["members"], loose["names"]] if loose else None
    projects = [[p["path"], p["owner"], p["members"]] for p in layout["projects"]]
    record = [layout["dogs"], tasks, optional, projects]
    if layout.get("links"):
        record.append([[s, layout["links"][s]] for s in sorted(layout["links"])])
    return digest(encode(record))


def read_registry(transport):
    scopes = set()
    cursor = None
    initial = None
    while True:
        path = "work-folders/scopes" + (
            "?cursor=" + hash_name(cursor) if cursor else ""
        )
        st, _, raw = transport.admin(path)
        value = decoded(st, raw)
        if cursor is None:
            initial = value["revision"]
        require(
            initial == value["revision"],
            "Working folder membership changed during discovery",
        )
        scopes.update(value["scopes"])
        cursor = value["cursor"]
        if not cursor:
            break
    return initial, scopes


def current_placement(transport):
    status, headers, raw = transport.admin("work-folders/placement")
    if status == 404:
        require(
            json.loads(raw).get("error") == "not_found",
            "Placement control route is not ready",
        )
        return None, None, None
    return decoded(status, raw), digest(raw), headers["etag"]


def prepare_cutover(mode, layout, baseline, claims, transport, journal):
    placement, previous, etag = current_placement(transport)
    if mode == "legacy":
        require(
            placement and placement["mode"] == "folders",
            "Legacy projection requires active separate folders",
        )
    registry, scopes = read_registry(transport)
    require(
        scopes == set(scopes_for(layout)) == {s["scope"] for s in claims},
        "Unaccounted working folder scope",
    )
    proof = {
        "v": 1,
        "mode": mode,
        "baselineManifest": baseline,
        "layoutSha256": layout_checksum(layout),
        "scopes": sorted(claims, key=lambda c: c["scope"]),
    }
    verification = digest(encode(proof))
    plan = {
        "v": 1,
        "origin": transport.identity,
        "previousEtag": etag,
        "registry": registry,
        "proof": proof,
        "next": {
            "v": 1,
            "mode": mode,
            "previous": previous,
            "baselineManifest": baseline,
            "verification": verification,
            "layout": layout,
        },
    }
    write_once(journal, plan)
    return plan


def fence(plan, transport, release, workers):
    next = plan["next"]
    require(plan["origin"] == transport.identity, "Plan belongs to another home")
    op = "unfence" if release else "fence"
    token = next["verification"]

    def namespace():
        st, _, raw = transport.admin(
            "work-folders/registry-" + op,
            "POST",
            {"revision": plan["registry"], "fence": token},
        )
        decoded(st, raw)

    def exchange(claim):
        st, _, raw = transport.folder(
            claim["scope"], op, "POST", {"revision": claim["revision"], "fence": token}
        )
        decoded(st, raw)

    if not release:
        namespace()
    parallel(plan["proof"]["scopes"], exchange, workers)
    if release:
        namespace()


def activate(plan, transport, workers, projection=None):
    proposed = plan["next"]
    placement, previous, _ = current_placement(transport)
    target = digest(encode(proposed))
    if previous == target:
        fence(plan, transport, True, workers)
        return target
    require(
        previous == proposed["previous"], "A different storage migration is now active"
    )
    if projection:
        st, _, prior = transport.admin("manifest.json")
        require(
            st == 200
            and digest(prior) in (projection[0], proposed["baselineManifest"]),
            "Legacy coordinator changed before its recovery snapshot was retained",
        )
        if digest(prior) == projection[0]:
            retain_snapshot(transport, prior, workers)
        retain_snapshot(transport, projection[2], workers)
        retain_snapshot(transport, projection[2], workers, repair=True)
    else:
        st, _, legacy = transport.admin("manifest.json")
        require(
            st == 200 and digest(legacy) == proposed["baselineManifest"],
            "The saved legacy source has changed",
        )
        retain_snapshot(transport, legacy, workers)
        stage_reference(transport, legacy)
    st, _, raw = transport.admin(
        "work-folders/verification/" + proposed["verification"], "PUT", plan["proof"]
    )
    decoded(st, raw)
    fence(plan, transport, False, workers)
    if projection:
        original_sha, original_etag, reconstructed = projection
        require(
            digest(reconstructed) == proposed["baselineManifest"],
            "Reconstructed bytes differ from journal",
        )
        st, _, raw = transport.admin(
            "work-folders/legacy-manifests/" + proposed["baselineManifest"],
            "PUT",
            reconstructed,
        )
        decoded(st, raw)
        st, _, raw = transport.admin(
            "work-folders/project-legacy",
            "POST",
            {"source": original_sha, "placement": proposed},
            {"if-match": original_etag},
        )
        decoded(st, raw)
    headers = (
        {"if-match": plan["previousEtag"]}
        if plan["previousEtag"]
        else {"if-none-match": "*"}
    )
    st, _, raw = transport.admin("work-folders/placement", "PUT", proposed, headers)
    require(decoded(st, raw)["revision"] == target, "Placement receipt differs")
    value, actual, _ = current_placement(transport)
    require(value == proposed and actual == target, "Placement readback differs")
    fence(plan, transport, True, workers)
    return target


def merged_layout(layout, registry):
    layout = json.loads(encode(layout))
    existing = set(scopes_for(layout))
    for scope in sorted(registry - existing):
        dog, folder = scope.split("/")
        key_for(dog, folder)
        if folder == "dog":
            layout["dogs"].append(dog)
        elif folder.startswith("task-"):
            key_for(dog, folder[5:])
            layout["tasks"].setdefault(dog, []).append(folder[5:])
        else:
            raise ValueError(
                "Working folder lacks a current authorized named-project mapping"
            )
    return layout


def reconstruct(package, hot, transport, workers, observed_layout=None):
    current, _, _ = current_placement(transport)
    require(current and current["mode"] == "folders", "Separate folders are inactive")
    _, registry = read_registry(transport)
    layout = merged_layout(observed_layout or current["layout"], registry)
    st, headers, old = transport.admin("manifest.json")
    decoded(st, old)
    source = json.loads(old)
    scopes, _, other = split_entries(source["entries"], layout)
    retained = {r["path"]: r for r in other}
    baseline = hash_name(current["baselineManifest"])
    st, _, original = transport.admin("work-folders/legacy-manifests/" + baseline)
    require(
        st == 200 and digest(original) == baseline,
        "The original coordinator snapshot is missing",
    )
    checkpoints = ".laterdog/checkpoints"
    original_rows = {row["path"]: row for row in json.loads(original)["entries"]}
    restore_paths = {
        p for p in original_rows if p == checkpoints or p.startswith(checkpoints + "/")
    }
    restore_reference(retained, baseline, original_rows, transport)
    for path in sorted(restore_paths):
        current_path = path
        while current_path:
            if current_path not in retained and current_path in original_rows:
                retained[current_path] = original_rows[current_path]
            current_path = current_path.rpartition("/")[0]
    for path in restore_paths:
        ancestor = path.rpartition("/")[0]
        while ancestor:
            require(
                retained.get(ancestor, {}).get("type") == "dir",
                "A retained checkpoint conflicts with a newer coordinator path",
            )
            ancestor = ancestor.rpartition("/")[0]
    claims = []
    projected = {}
    blobs = {}
    loose_names = set()
    for scope, prefix in sorted(scopes.items()):
        head = transport.head(scope)
        require(
            head and (head["state"] == "tombstone" or head["state"] == "live"),
            "Missing versioned root cannot be treated as deleted",
        )

        def contents(h):
            for folder in (hot, package.blobs):
                p = folder / h
                if p.exists():
                    return p.read_bytes()
            raw = transport.object(scope, "blobs", h)
            require(package.put_blob(raw) == h, "Fetched restore object changed")
            return raw

        tree = read_tree(transport, scope, head["manifest"], package, contents)
        rows = tree["rows"]
        copies = {}
        for path, row in rows.items():
            if not prefix and not path:
                continue
            if not prefix:
                require(
                    "/" not in path
                    and not path.startswith(".")
                    and row["type"] != "dir",
                    "Loose files conflict with a coordinator namespace",
                )
                loose_names.add(path)
            absolute = prefix + ("/" + path if path and prefix else path)
            require(
                absolute not in retained and absolute not in projected,
                "Overlapping allocated roots",
            )
            projected[absolute] = {
                "path": absolute,
                **{k: v for k, v in row.items() if k != "sha256"},
            }
            if "hardlink" in row:
                projected[absolute]["hardlink"] = (
                    prefix + "/" if prefix else ""
                ) + row["hardlink"]
            copies[path] = dict(row)
        if not prefix and rows:
            copies[""] = rows[""]
        restored = (
            canonical_digest(copies) if head["manifest"] else digest(b"tombstone")
        )
        require(
            restored == tree["checksum"], "Projected output differs from current folder"
        )
        claims.append(
            {
                "scope": scope,
                "revision": head["revision"],
                "manifest": head["manifest"],
                "sourceTree": tree["checksum"],
                "restoredTree": restored,
            }
        )
        for h in tree["hashes"]:
            blobs.setdefault(h, scope)
    if layout.get("loose"):
        layout["loose"]["names"] = sorted(loose_names)

    def requests():
        by_scope = {}
        for h, scope in blobs.items():
            by_scope.setdefault(scope, []).append(h)
        for scope, hashes in by_scope.items():
            for n in range(0, len(hashes), 48):
                yield scope, hashes[n : n + 48]

    def copy(item):
        scope, hashes = item
        st, _, body = transport.admin(
            "work-folders/project-blobs", "POST", {"scope": scope, "hashes": hashes}
        )
        require(
            decoded(st, body)["verified"] == hashes,
            "Legacy content projection was not verified",
        )

    parallel(requests(), copy, workers)
    if LEDGER in retained:
        row = retained[LEDGER]

        def control_blob(h):
            st, _, b = transport.admin("blobs/" + h)
            require(st == 200, "Missing original cold ledger object")
            return b

        ledger = json.loads(b"".join(file_bytes(row, control_blob)))
        cleaned = {
            k: v
            for k, v in ledger.items()
            if not (k.split("/")[1] in layout["tasks"].get(k.split("/")[0], []))
        }
        if cleaned != ledger:
            b = encode(cleaned)
            h = digest(b)
            st, _, _ = transport.admin("blobs/" + h, "PUT", b)
            require(
                200 <= st < 300 and control_blob(h) == b,
                "Compatible cold ledger was not saved",
            )
            retained[LEDGER] = {**row, "size": len(b), "chunks": [h]}
    for path in list(projected):
        parent = path.rpartition("/")[0]
        while parent and parent not in retained and parent not in projected:
            require(
                parent.startswith(".laterdog")
                and (TASKS.startswith(parent + "/") or parent.startswith(TASKS)),
                "Missing compatible non-working parent",
            )
            retained[parent] = {
                "path": parent,
                "type": "dir",
                "mode": 0o700,
                "mtimeMs": 0,
            }
            parent = parent.rpartition("/")[0]
    retained.update(projected)
    source["entries"] = [retained[p] for p in sorted(retained)]
    output = encode(source)
    return layout, claims, (digest(old), headers["etag"], output)
