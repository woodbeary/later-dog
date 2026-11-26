import io
import json
import tarfile
from legacy import LEDGER, digest, encode, note, require
from rollout import activate, prepare_cutover, reconstruct
from snapshot import canonical_digest, prepare
from transfer import decoded, publish


def migration_scenario(directory, transport):
    directory.mkdir(mode=0o700, exist_ok=True)
    hot = directory / "old-blobs"
    hot.mkdir(exist_ok=True)
    archived = directory / "archive-blobs"
    archived.mkdir(exist_ok=True)

    def blob(folder, data):
        h = digest(data)
        (folder / h).write_bytes(data)
        return h

    def entry(path, kind="dir", mode=0o750, **extra):
        return {
            "path": path,
            "type": kind,
            "mode": mode,
            "mtimeMs": 1590000000000,
            **extra,
        }

    def file(path, data):
        return entry(
            path,
            "file",
            0o640,
            size=len(data),
            chunks=[blob(hot, data)] if data else [],
        )

    stamp = "q123"
    tarbytes = io.BytesIO()
    with tarfile.open(fileobj=tarbytes, mode="w") as out:
        for path, data in [
            (".", None),
            ("./empty", None),
            ("./resume.bin", b"old\0archived"),
            ("./link", b"resume.bin"),
        ]:
            item = tarfile.TarInfo(path)
            item.mode, item.mtime = (0o751 if data is None else 0o740), 1540000000
            if path == "./link":
                item.type, item.linkname = tarfile.SYMTYPE, data.decode()
            elif data is None:
                item.type = tarfile.DIRTYPE
            else:
                item.size = len(data)
            out.addfile(item, io.BytesIO(data) if data and path != "./link" else None)
    rawtar = tarbytes.getvalue()
    part = "wf-old-" + stamp + "-0001.tar"
    oldrecord = {
        "stamp": stamp,
        "parts": [{"name": part, "bytes": len(rawtar), "sha256": digest(rawtar)}],
        "bytes": 12,
        "files": 1,
        "movedAt": 1570000000000,
        "cleared": True,
    }
    index = {
        "version": 1,
        "entries": {
            ".laterdog/checkpoints/work-folders/fixtureA/" + part: {
                "size": len(rawtar),
                "chunks": [blob(archived, rawtar)],
            }
        },
    }
    from previous_backup import (
        ARCHIVE,
        DIRECTORY,
        DESCRIPTION,
        REFERENCE,
        restore_reference,
    )

    entries = [
        entry(".laterdog/.backups"),
        entry(DIRECTORY.rstrip("/")),
        file(ARCHIVE, b"original previous backup"),
        file(DESCRIPTION, b"original backup description"),
        entry(".laterdog/checkpoints"),
        entry(".laterdog/checkpoints/repo"),
        file(".laterdog/checkpoints/repo/HEAD", b"original checkpoint"),
        entry(".laterdog"),
        entry(".laterdog/workspaces"),
        entry(".laterdog/workspaces/fixtureA"),
        entry(".laterdog/task-workspaces"),
        entry(".laterdog/task-workspaces/fixtureA"),
        entry(".laterdog/task-workspaces/fixtureA/old"),
        file(".laterdog/task-workspaces/fixtureA/old/MOVED-OUT.md", note(oldrecord)),
        file(LEDGER, encode({"fixtureA/old": oldrecord})),
        file(".laterdog/metadata.json", b"coordinator-control"),
        entry("project"),
        file("project/report", b"first version"),
        {**file("project/report-copy", b"first version"), "hardlink": "project/report"},
        entry("project/empty"),
        entry("project/inside", "link", 0o777, target="/data/project/report"),
        entry("project/outside", "link", 0o777, target="/etc/hostname"),
        file("archive.tgz", b"first loose file"),
    ]
    old = {"version": 1, "createdAt": 1560000000000, "entries": entries}
    approved = {
        "projects": [
            {
                "path": "/data/project",
                "owner": "fixtureA",
                "members": ["fixtureA", "fixtureB"],
            }
        ],
        "loose": {
            "owner": "fixtureA",
            "members": ["fixtureA"],
            "names": ["archive.tgz"],
        },
    }
    for name, data in (("legacy", old), ("index", index), ("approved", approved)):
        (directory / name).write_bytes(encode(data))
    status, _, _ = transport.admin("manifest.json", "PUT", encode(old))
    require(status == 201, "Isolated fixture source was not saved")
    for fp in hot.iterdir():
        h = fp.name
        require(
            transport.admin("blobs/" + h, "PUT", (hot / h).read_bytes())[0] == 201,
            "Missing fixture coordinator data",
        )
    for fp in archived.iterdir():
        require(
            transport.admin("archive/blobs/" + fp.name, "PUT", fp.read_bytes())[0]
            == 201,
            "Missing original archived fixture data",
        )
    original_root = entry("")
    extra = b"uncached original working data"
    missing = file("node_modules/result", extra)
    added = entry("node_modules")
    supplement = {
        "v": 1,
        "baselineManifest": digest(encode(old)),
        "census": digest(b"frozen fixture"),
        "scopes": {
            "fixtureA/dog": {
                "baseTree": canonical_digest({"": original_root}),
                "resultTree": canonical_digest(
                    {
                        "": original_root,
                        "node_modules": added,
                        "node_modules/result": {**missing, "sha256": digest(extra)},
                    }
                ),
                "changes": [
                    {"path": "node_modules", "entry": added},
                    {"path": "node_modules/result", "entry": missing},
                ],
            }
        },
    }
    (directory / "supplement").write_bytes(encode(supplement))
    package = prepare(
        directory / "legacy",
        directory / "index",
        directory / "approved",
        hot,
        archived,
        directory / "package",
        directory / "supplement",
    )
    layout = package.authorized_layout()
    claims = publish(package, hot, transport, 3)
    from retention import retain_snapshot

    cold_map = encode(package.load("cold-archive-map-v1"))
    cold_receipt = retain_snapshot(transport, cold_map, 3)
    require(cold_receipt["unique"] == 1, "Historical archived content was not pinned")
    forward = prepare_cutover(
        "folders",
        layout,
        digest(encode(old)),
        claims,
        transport,
        directory / "activate.json",
        cold_receipt["snapshot"],
    )
    from candidate_plan import pack, upload
    import gzip

    plans = directory / "candidate"
    packaged = pack(package, forward, plans)
    require(
        pack(package, forward, plans) == packaged and packaged["scopes"] == 4,
        "Repacked candidate plan is not deterministic",
    )
    require(
        upload(packaged, plans, transport, 3)["verified"],
        "Candidate plan did not survive remote readback",
    )
    plan_index = json.loads((plans / packaged["index"]).read_bytes())
    project_plan = next(r for r in plan_index["scopes"] if "/project-" in r["scope"])
    row_map = {
        r["path"]: r
        for r in json.loads(
            gzip.decompress((plans / project_plan["sha256"]).read_bytes())
        )["rows"]
    }
    require(
        row_map["report"]["chunks"] == [digest(b"first version")]
        and row_map["report-copy"]["hardlink"] == "report"
        and row_map["outside"]["target"] == "/etc/hostname"
        and b"first version"
        not in gzip.decompress((plans / project_plan["sha256"]).read_bytes()),
        "Candidate metadata changed or included file payload",
    )
    activation = activate(forward, transport, 3)
    project = "fixtureA/project-" + digest(b"/data/project")
    first = transport.head(project)

    def put(scope, kind, data):
        h = digest(data)
        st, _, _ = transport.folder(scope, kind + "/" + h, "PUT", data)
        require(st == 201, "Updated fixture object was not saved")
        return h

    new = b"new bytes from another guest\0"
    bh = put(project, "blobs", new)
    ch = put(project, "manifests", encode({"v": 1, "kind": "chunks", "hashes": [bh]}))
    prior = json.loads(transport.object(project, "manifests", first["manifest"]))
    page = json.loads(transport.object(project, "manifests", prior["entries"]))
    for target in page["entries"]:
        if target["path"] in ("report", "report-copy"):
            target.update(size=len(new), sha256=bh, contents=ch, mtimeMs=1590000000123)
    prior["entries"] = put(project, "manifests", encode(page))
    changed = put(project, "manifests", encode(prior))
    reply = transport.folder(
        project, "commit", "POST", {"parent": first["revision"], "manifest": changed}
    )
    newer = decoded(reply[0], reply[2])
    require(newer["manifest"] == changed, "Newer guest revision was not published")
    task = "fixtureA/task-old"
    oldtask = transport.head(task)
    reply = transport.folder(
        task, "commit", "POST", {"parent": oldtask["revision"], "manifest": None}
    )
    require(
        decoded(reply[0], reply[2])["state"] == "tombstone",
        "Fixture deletion did not persist",
    )
    newtask = "fixtureA/task-created"
    empty = put(
        newtask, "manifests", encode({"v": 1, "kind": "entries", "entries": []})
    )
    created = put(
        newtask,
        "manifests",
        encode({"v": 1, "kind": "root", "mode": 0o710, "entries": empty}),
    )
    require(
        transport.folder(
            newtask, "commit", "POST", {"parent": None, "manifest": created}
        )[0]
        == 201,
        "Post-cutover task was not created",
    )
    original_rows = {r["path"]: r for r in entries}
    current_rows = {
        k: v
        for k, v in original_rows.items()
        if k != ARCHIVE and not k.startswith(".laterdog/checkpoints")
    }
    baseline_ref = {
        "v": 1,
        "source": "baseline",
        "baseline": digest(encode(old)),
        "size": len(b"original previous backup"),
    }
    current_rows[REFERENCE] = file(REFERENCE, encode(baseline_ref))
    baseline_projection = dict(current_rows)
    restore_reference(
        baseline_projection, baseline_ref["baseline"], original_rows, transport
    )
    require(
        baseline_projection[ARCHIVE] == original_rows[ARCHIVE],
        "Historical previous backup was not reconstructed",
    )
    removed = {
        k: v for k, v in current_rows.items() if k not in (REFERENCE, DESCRIPTION)
    }
    restore_reference(removed, baseline_ref["baseline"], original_rows, transport)
    require(ARCHIVE not in removed, "A removed previous backup was resurrected")
    import hmac

    current_backup = b"updated private previous backup"
    updated = digest(current_backup)
    size = len(current_backup)
    ref = {
        "v": 1,
        "source": "archive",
        "sha256": updated,
        "size": size,
        "chunks": [updated],
    }
    signing = hmac.digest(
        transport.bootstrap.encode(),
        b"laterdog.previous-cloud-signing-key.v1",
        "sha256",
    )
    ref["signature"] = hmac.digest(
        signing,
        encode(["laterdog.previous-cloud-archive.v1", size, updated, [updated]]),
        "sha256",
    ).hex()
    verify_path = "work-folders/verify-previous-backup"
    require(
        transport.admin(verify_path, "POST", {**ref, "signature": "0" * 64})[0] == 403,
        "Bad signature verified",
    )
    st, _, body = transport.admin(verify_path, "POST", ref)
    require(
        decoded(st, body) == {"verified": True},
        "Private previous backup could not be verified",
    )
    require(
        transport.admin(verify_path, "POST", {**ref, "sha256": "e" * 64})[0] == 403,
        "Modified private previous backup verified",
    )
    require(
        transport.admin("archive/blobs/" + updated, "PUT", current_backup)[0] == 201,
        "New private previous backup could not be saved",
    )
    current_rows[REFERENCE] = file(REFERENCE, encode(ref))
    current_rows[DESCRIPTION] = file(DESCRIPTION, b"new user-selected backup")
    for cy in (REFERENCE, DESCRIPTION):
        b = (hot / current_rows[cy]["chunks"][0]).read_bytes()
        require(
            transport.admin("blobs/" + digest(b), "PUT", b)[0] == 201,
            "Current metadata upload failed",
        )
    require(
        transport.admin(
            "manifest.json",
            "PUT",
            encode({**old, "entries": list(current_rows.values())}),
        )[0]
        == 201,
        "Current coordinator state failed to save",
    )
    backlayout, backclaims, projection = reconstruct(package, hot, transport, 3)
    back = prepare_cutover(
        "legacy",
        backlayout,
        digest(projection[2]),
        backclaims,
        transport,
        directory / "rollback.json",
    )
    rollback = activate(back, transport, 3, projection)
    restored = json.loads(transport.admin("manifest.json")[2])
    rows = {e["path"]: e for e in restored["entries"]}
    require(
        rows[ARCHIVE]["chunks"] == [updated]
        and REFERENCE not in rows
        and rows[DESCRIPTION] == current_rows[DESCRIPTION]
        and transport.admin("blobs/" + updated)[2] == current_backup,
        "Rollback lost the newest signed previous backup",
    )
    require(
        rows[".laterdog/checkpoints/repo/HEAD"]
        == original_rows[".laterdog/checkpoints/repo/HEAD"],
        "Git checkpoint missing from rollback",
    )
    require(
        rows["project/report"]["chunks"] == [bh]
        and rows["project/report-copy"]["hardlink"] == "project/report"
        and rows[".laterdog/workspaces/fixtureA/node_modules/result"]["chunks"]
        == [digest(extra)]
        and transport.admin("blobs/" + bh)[2] == new,
        "Latest edit was not physically recovered",
    )
    require(
        rows["project/inside"]["target"] == "/data/project/report"
        and rows["project/outside"]["target"] == "/etc/hostname",
        "Historical link provenance differs",
    )
    require(
        rows["project/empty"]["type"] == "dir"
        and rows[".laterdog/task-workspaces/fixtureA/created"]["mode"] == 0o710,
        "Empty or newly created directory was lost",
    )
    require(
        not any(p.startswith(".laterdog/task-workspaces/fixtureA/old") for p in rows),
        "A deleted folder was resurrected",
    )
    require(
        rows[".laterdog/metadata.json"]
        == next(e for e in entries if e["path"] == ".laterdog/metadata.json"),
        "Coordinator data changed",
    )
    require(
        json.loads(transport.admin("blobs/" + rows[LEDGER]["chunks"][0])[2]) == {},
        "Old cold ledger would restore a deleted folder",
    )
    require(
        transport.admin("work-folders/legacy-manifests/" + digest(encode(old)))[2]
        == encode(old),
        "Immutable original manifest is missing",
    )
    from retention import retain_snapshot

    closure = retain_snapshot(transport, encode(old), 3, True)
    require(
        closure["unique"] == len({h for e in entries for h in e.get("chunks", [])}),
        "Original retained blob set changed",
    )
    require(
        activate(back, transport, 3, projection) == rollback,
        "Retry failed after a successful rollback",
    )
    require(
        transport.folder(
            project, "commit", "POST", {"parent": newer["revision"], "manifest": None}
        )[0]
        == 423,
        "A stale writer published after rollback",
    )
    return {
        "retainedColdArchive": cold_receipt,
        "signedPreviousBackup": updated,
        "supplementalHash": digest(extra),
        "closure": closure,
        "scopes": len(claims),
        "rollbackScopes": len(backclaims),
        "original": digest(encode(old)),
        "forward": activation,
        "rollback": rollback,
        "originalRevision": first["revision"],
        "newRevision": newer["revision"],
        "latestBytes": bh,
        "reconstructed": digest(projection[2]),
    }
