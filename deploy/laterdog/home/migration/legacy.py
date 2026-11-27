import datetime
import hashlib
import json
import math
import posixpath
import re
import tarfile

CHUNK = 8 * 1024 * 1024
HASH = re.compile(r"[a-f0-9]{64}")
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
TASKS = ".laterdog/task-workspaces/"
DOGS = ".laterdog/workspaces/"
LEDGER = ".laterdog/work-folders.json"


def require(ok, message):
    if not ok:
        raise ValueError(message)


def encode(value):
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def path_name(name):
    require(
        isinstance(name, str)
        and all(part not in ("", ".", "..") for part in name.split("/"))
        and "\0" not in name,
        "Unsafe source path",
    )
    name.encode()
    return name


def hash_name(value):
    require(
        isinstance(value, str) and HASH.fullmatch(value), "Invalid content checksum"
    )
    return value


def mode_time(row):
    mode = row["mode"]
    require(type(mode) is int and 0 <= mode <= 0o7777, "Invalid mode")
    out = {"mode": mode}
    if "mtimeMs" in row:
        t = row["mtimeMs"]
        require(
            type(t) in (float, int) and math.isfinite(t) and abs(t) <= 8.64e15,
            "Invalid source timestamp",
        )
        out["mtimeMs"] = t
    return out


def key_for(owner, folder):
    require(ID.fullmatch(owner) and ID.fullmatch(folder), "Invalid folder authority")
    return owner + "/" + folder


def folder_layout(entries, projects, cold):
    dogs = set()
    tasks = {}
    for row in entries:
        path = row["path"]
        if path.startswith(DOGS):
            dog = path[len(DOGS) :].split("/")[0]
            require(ID.fullmatch(dog), "Malformed dog namespace")
            dogs.add(dog)
        if path.startswith(TASKS):
            parts = path[len(TASKS) :].split("/")
            require(ID.fullmatch(parts[0]), "Malformed task owner")
            tasks.setdefault(parts[0], set())
            if len(parts) > 1:
                require(ID.fullmatch(parts[1]), "Malformed task namespace")
                tasks[parts[0]].add(parts[1])
    for key in cold:
        dog, thread = key.split("/")
        require(
            ID.fullmatch(dog) and ID.fullmatch(thread),
            "Invalid archived task namespace",
        )
        tasks.setdefault(dog, set()).add(thread)
    layout = {
        "dogs": sorted(dogs),
        "tasks": {dog: sorted(threads) for dog, threads in sorted(tasks.items())},
    }
    if projects.get("loose"):
        loose = projects["loose"]
        layout["loose"] = {k: loose[k] for k in ("owner", "members", "names")}
    layout["projects"] = [
        {k: p[k] for k in ("path", "owner", "members")} for p in projects["projects"]
    ]
    return layout


def scopes_for(layout):
    mapping = {key_for(d, "dog"): DOGS + d for d in layout["dogs"]}
    for dog, threads in layout["tasks"].items():
        for t in threads:
            mapping[key_for(dog, "task-" + t)] = TASKS + dog + "/" + t
    for project in layout["projects"]:
        p = project["path"]
        require(
            p.startswith("/data/")
            and not path_name(p[6:]).split("/")[0].startswith("."),
            "Project is outside visible data",
        )
        key = key_for(project["owner"], "project-" + digest(p.encode()))
        require(key not in mapping, "Duplicate project scope")
        mapping[key] = p[6:]
    if layout.get("loose"):
        spec = layout["loose"]
        require(
            all(
                "/" not in path_name(n) and not n.startswith(".") for n in spec["names"]
            ),
            "Invalid loose files",
        )
        mapping[key_for(spec["owner"], "loose")] = ""
    require(len(set(mapping.values())) == len(mapping), "Duplicate scoped path")
    return mapping


def split_entries(entries, layout):
    scopes = scopes_for(layout)
    by_path = {path: scope for scope, path in scopes.items() if path}
    loose = layout.get("loose")
    loose_names = set(loose["names"]) if loose else set()
    selected = {s: {} for s in scopes}
    rest = []
    for row in entries:
        path = path_name(row["path"])
        scope = None
        p = path
        while p and p not in by_path:
            p = posixpath.dirname(p)
        if p:
            scope, relative = by_path[p], path[len(p) :].lstrip("/")
        elif path in loose_names:
            require(row["type"] != "dir", "Directory needs a named project scope")
            scope, relative = key_for(loose["owner"], "loose"), path
        if scope is None:
            require(path.startswith("."), "Visible working data has no recorded scope")
            require(
                not path.startswith(DOGS)
                and not (path.startswith(TASKS) and path.count("/") >= 3),
                "Working folder has no recorded owner",
            )
            rest.append(row)
        else:
            require(relative not in selected[scope], "Duplicate source path")
            if row.get("hardlink") is not None:
                linked = path_name(row["hardlink"])
                if p:
                    require(
                        linked.startswith(p + "/"),
                        "A legacy hard link crosses a storage authority boundary",
                    )
                    linked = linked[len(p) + 1 :]
                else:
                    require(
                        linked in loose_names, "A loose hard link lacks a named target"
                    )
                row = {**row, "hardlink": linked}
            selected[scope][relative] = row
    return scopes, selected, rest


def note(record):
    day = (
        datetime.datetime.fromtimestamp(record["movedAt"] / 1000, datetime.timezone.utc)
        .date()
        .isoformat()
    )
    mb = math.floor(record["bytes"] / 1048576 + 0.5)
    return (
        "# This chat's files are in storage\n\nlater.dog moved %d file(s), %d MB, off the disk on %s to make room, because this chat had been quiet.\nThey come back by themselves when the chat's next turn starts. Nothing was deleted.\n"
        % (record["files"], mb, day)
    ).encode()


def file_bytes(row, read):
    size = 0
    for h in row["chunks"]:
        chunk = read(hash_name(h))
        require(
            digest(chunk) == h and 0 < len(chunk) <= CHUNK, "Damaged legacy blob " + h
        )
        size += len(chunk)
        yield chunk
    require(size == row["size"], "Legacy file size differs")


def archive_parts(key, record, resident, archived, read, archive_read, output):
    owner, thread = key.split("/")
    stamp = record["stamp"]
    require(
        isinstance(stamp, str) and re.fullmatch(r"[a-zA-Z0-9_-]+", stamp),
        "Invalid archive generation",
    )
    require(record["parts"], "Missing archive parts")
    total = hashlib.sha256()
    part_hashes = []
    with output.open("wb") as dest:
        for ordinal, part in enumerate(record["parts"], 1):
            name = f"wf-{thread}-{stamp}-{ordinal:04}.tar"
            require(name == part["name"], "Unexpected archive part or order")
            path = ".laterdog/checkpoints/work-folders/" + owner + "/" + name
            source = archived.get(path)
            reader = archive_read
            if source is None:
                source, reader = resident.get(path), read
            require(
                source is not None and source["size"] == part["bytes"],
                "Archive part is missing or changed",
            )
            h = hashlib.sha256()
            for b in file_bytes(source, reader):
                h.update(b)
                total.update(b)
                dest.write(b)
            require(
                part.get("sha256", h.hexdigest()) == h.hexdigest(),
                "Archive part checksum differs",
            )
            part_hashes.append(h.hexdigest())
    return {"sha256": total.hexdigest(), "parts": part_hashes}


def scan_tar(path, record, put_blob):
    entries = {}
    files = size = 0
    aliases = {}
    with tarfile.open(path, "r|") as archive:
        for m in archive:
            name = m.name.rstrip("/") if m.isdir() else m.name
            if name != ".":
                name = path_name(name[2:] if name.startswith("./") else name)
            else:
                name = ""
            require(name not in entries, "Duplicate archived path")
            row = {
                "path": name,
                "mtimeMs": float(m.pax_headers.get("mtime", m.mtime)) * 1000,
                "mode": m.mode,
            }
            if row["mtimeMs"].is_integer():
                row["mtimeMs"] = int(row["mtimeMs"])
            mode_time(row)
            if m.isdir():
                row["type"] = "dir"
            elif m.issym():
                row.update(type="link", target=m.linkname)
            elif m.islnk():
                target = m.linkname
                aliases[name] = path_name(
                    target[2:] if target.startswith("./") else target
                )
                row["type"] = "hardlink"
            elif m.isfile():
                content = archive.extractfile(m)
                require(content is not None, "Unreadable archive member")
                chunks = []
                actual = 0
                while True:
                    data = content.read(CHUNK)
                    if not data:
                        break
                    chunks.append(put_blob(data))
                    actual += len(data)
                require(actual == m.size, "Incomplete archive member")
                row.update(type="file", size=actual, chunks=chunks)
                files += 1
                size += actual
            else:
                raise ValueError(
                    "Unsupported archived entry type; existing archive retained"
                )
            entries[name] = row
    groups = {}
    for path, target in aliases.items():
        seen = {path}
        while target in aliases:
            require(target not in seen, "Cyclic archive hard link")
            seen.add(target)
            target = aliases[target]
        require(
            target in entries and entries[target]["type"] == "file",
            "Missing archive hard-link target",
        )
        groups.setdefault(target, []).append(path)
    for target, members in groups.items():
        origin = entries[target]
        names = sorted([target, *members])
        for path in names:
            require(
                mode_time(entries[path]) == mode_time(origin),
                "Archived hard links disagree on inode metadata",
            )
            alias = {**origin, "path": path}
            if path != names[0]:
                alias["hardlink"] = names[0]
            entries[path] = alias
        files += len(members)
        size += len(members) * origin["size"]
    require(
        "" in entries and entries[""]["type"] == "dir", "Archive has no root directory"
    )
    require(
        (files, size) == (record["files"], record["bytes"]),
        "Cold archive disagrees with recorded inventory",
    )
    return entries


def merge_cold(resident, archived, record, read):
    working = dict(resident)
    if not record["cleared"]:
        require(working, "Non-cleared snapshot lacks resident working files")
        return working
    stub = working.get("MOVED-OUT.md")
    if (
        stub
        and stub["type"] == "file"
        and stub["size"] <= 2048
        and b"".join(file_bytes(stub, read)) == note(record)
    ):
        del working["MOVED-OUT.md"]
    working.pop("", None)
    for path, row in working.items():
        if path not in archived:
            archived[path] = row
            continue
        old = archived[path]
        require(
            {k: v for k, v in old.items() if k not in ("path", "mtimeMs")}
            == {k: v for k, v in row.items() if k not in ("path", "mtimeMs")},
            "Resident data conflicts with cold archive at " + path,
        )
        archived[path] = row
    return archived


def link_fields(folder, path, target, loose_names=()):
    require(
        isinstance(target, str) and target and "\0" not in target, "Invalid symlink"
    )
    base = "/data/" + folder if folder else "/data"
    destination = posixpath.normpath(
        posixpath.join(base, posixpath.dirname(path), target)
    )
    within = destination == base or destination.startswith(base + "/")
    delta = posixpath.relpath(
        destination, posixpath.join(base, posixpath.dirname(path))
    )
    fields = {"target": target}
    if not folder:
        if not within or posixpath.relpath(destination, base) not in loose_names:
            fields["scopedTarget"] = None
        elif target.startswith("/"):
            fields["scopedTarget"] = delta
    elif target.startswith("/") or not within:
        fields["scopedTarget"] = delta if within else None
    return fields
