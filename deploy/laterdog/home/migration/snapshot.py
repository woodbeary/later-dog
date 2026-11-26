import gzip
import hashlib
import json
import os
import pathlib
import posixpath
import sqlite3
import tempfile
from legacy import (
    LEDGER,
    digest,
    encode,
    file_bytes,
    folder_layout,
    hash_name,
    key_for,
    link_fields,
    merge_cold,
    mode_time,
    path_name,
    require,
    scopes_for,
    scan_tar,
    archive_parts,
    split_entries,
)


def bytes_from(path):
    content = path.read_bytes()
    return gzip.decompress(content) if content.startswith(b"\x1f\x8b") else content


def canonical_digest(rows):
    h = hashlib.sha256()
    for path, row in sorted(rows.items()):
        metadata = [
            path,
            row["type"],
            row.get("mode"),
            row.get("mtimeMs"),
            row.get("size"),
            row.get("sha256"),
            row.get("target"),
        ]
        if row.get("hardlink") is not None:
            metadata.append(row["hardlink"])
        h.update(encode(metadata))
        h.update(b"\n")
    return h.hexdigest()


def hash_rows(rows, read):
    result = {}
    for path, row in rows.items():
        result[path] = dict(row)
        if row["type"] == "file":
            h = hashlib.sha256()
            for b in file_bytes(row, read):
                h.update(b)
            result[path]["sha256"] = h.hexdigest()
    return result


class Package:
    def __init__(self, directory):
        self.directory = pathlib.Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.blobs = self.directory / "blobs"
        self.blobs.mkdir(exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(self.directory / "index.sqlite", timeout=30)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS nodes(hash TEXT PRIMARY KEY,data BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS objects(scope TEXT NOT NULL,kind TEXT NOT NULL,hash TEXT NOT NULL,rank INTEGER NOT NULL,PRIMARY KEY(scope,kind,hash));
        CREATE TABLE IF NOT EXISTS scopes(scope TEXT PRIMARY KEY,root TEXT NOT NULL,source TEXT NOT NULL,entries INTEGER NOT NULL,bytes INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS originals(scope TEXT PRIMARY KEY,root TEXT NOT NULL,source TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS state(name TEXT PRIMARY KEY,data BLOB NOT NULL);
        """)
        self.scope = None

    def put_blob(self, data):
        h = digest(data)
        file = self.blobs / h
        if not file.exists():
            fd, tmp = tempfile.mkstemp(dir=self.blobs)
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(data)
                os.replace(tmp, file)
            finally:
                pathlib.Path(tmp).unlink(missing_ok=True)
        return h

    def register(self, kind, h, rank):
        self.db.execute(
            "INSERT OR IGNORE INTO objects VALUES(?,?,?,?)", (self.scope, kind, h, rank)
        )

    def node(self, value, rank):
        data = encode(value)
        h = digest(data)
        self.db.execute("INSERT OR IGNORE INTO nodes VALUES(?,?)", (h, data))
        self.register("manifests", h, rank)
        return h

    def pages(self, kind, items, rank):
        key = "hashes" if kind == "chunks" else "entries"
        hashes = [
            self.node({"v": 1, "kind": kind, key: items[n : n + 64]}, rank)
            for n in range(0, max(1, len(items)), 64)
        ]
        while len(hashes) > 1:
            rank += 1
            hashes = [
                self.node(
                    {
                        "v": 1,
                        "kind": "pages",
                        "of": kind,
                        "children": hashes[n : n + 64],
                    },
                    rank,
                )
                for n in range(0, len(hashes), 64)
            ]
        return hashes[0]

    def metadata(self, name, value):
        data = encode(value)
        old = self.db.execute("SELECT data FROM state WHERE name=?", (name,)).fetchone()
        require(
            not old or old[0] == data,
            "Existing migration package belongs to another snapshot or layout",
        )
        self.db.execute("INSERT OR IGNORE INTO state VALUES(?,?)", (name, data))

    def load(self, name):
        return json.loads(
            self.db.execute("SELECT data FROM state WHERE name=?", (name,)).fetchone()[
                0
            ]
        )

    def authorized_layout(self):
        layout = self.load("layout")
        projects = sorted(
            (p["path"] for p in layout["projects"]), key=len, reverse=True
        )
        scopes = scopes_for(layout)
        links = {}
        counts = {"within": 0, "crossProject": 0, "outside": 0}
        for scope, data in self.db.execute(
            "SELECT o.scope,n.data FROM objects o JOIN nodes n ON o.hash=n.hash WHERE o.rank=64"
        ):
            page = json.loads(data)
            for entry in page.get("entries", []):
                if entry["kind"] != "link":
                    continue
                if entry.get("scopedTarget", "") is not None:
                    counts["within"] += 1
                    continue
                base = "/data/" + scopes[scope]
                target = posixpath.normpath(
                    posixpath.join(
                        base, posixpath.dirname(entry["path"]), entry["target"]
                    )
                )
                project = next(
                    (p for p in projects if target == p or target.startswith(p + "/")),
                    None,
                )
                if project:
                    links.setdefault(scope, set()).add(project)
                    counts["crossProject"] += 1
                else:
                    counts["outside"] += 1
        if links:
            layout["links"] = {k: sorted(v) for k, v in sorted(links.items())}
        self.metadata("linkCounts", counts)
        self.db.commit()
        return layout

    def build(
        self, scope, folder, entries, read_blob, previous_version=False, deleted=False
    ):
        self.scope = scope
        if deleted:
            require(not entries, "Only a fully absent scope can be recorded as deleted")
            claim = (scope, "", digest(b"tombstone"))
            if previous_version:
                self.db.execute("INSERT OR REPLACE INTO originals VALUES(?,?,?)", claim)
            else:
                self.db.execute("INSERT INTO scopes VALUES(?,?,?,?,?)", (*claim, 0, 0))
            self.db.commit()
            return
        root = entries.get("")
        if root is None and not folder:
            root = {"type": "dir", "mode": 0o700}
        require(
            root and root["type"] == "dir",
            "Source root is missing or has an unsupported type",
        )
        rows = {"": root}
        declared = []
        total = 0
        for path, original in sorted(entries.items()):
            if not path:
                continue
            path_name(path)
            parent = path.rpartition("/")[0]
            require(
                parent in rows and rows[parent]["type"] == "dir",
                "Missing or non-directory source parent",
            )
            row = dict(original)
            kind = row["type"]
            entry = {"path": path, "kind": kind, **mode_time(row)}
            if kind == "file":
                h = hashlib.sha256()
                for b in file_bytes(row, read_blob):
                    h.update(b)
                for blob in row["chunks"]:
                    self.register("blobs", blob, 0)
                row["sha256"] = h.hexdigest()
                if "hardlink" in row:
                    target = row["hardlink"]
                    original = rows.get(path_name(target))
                    require(
                        original
                        and target < path
                        and "hardlink" not in original
                        and all(
                            original.get(k) == row.get(k)
                            for k in (
                                "type",
                                "sha256",
                                "mode",
                                "mtimeMs",
                                "size",
                                "chunks",
                            )
                        ),
                        "Hard link no longer matches its canonical file",
                    )
                    entry["hardlink"] = target
                total += row["size"]
                entry.update(
                    size=row["size"],
                    sha256=row["sha256"],
                    contents=self.pages("chunks", row["chunks"], 1),
                )
            elif kind == "link":
                entry.update(link_fields(folder, path, row["target"], entries.keys()))
            else:
                require(kind == "dir", "Unsupported work folder entry")
            rows[path] = row
            declared.append(entry)
        content = self.pages("entries", declared, 64)
        manifest = self.node(
            {"v": 1, "kind": "root", **mode_time(root), "entries": content}, 128
        )
        proof = canonical_digest(rows)
        if previous_version:
            self.db.execute(
                "INSERT OR REPLACE INTO originals VALUES(?,?,?)",
                (scope, manifest, proof),
            )
        else:
            self.db.execute(
                "INSERT INTO scopes VALUES(?,?,?,?,?)",
                (scope, manifest, proof, len(rows) - 1, total),
            )
        self.db.commit()


def prepare(
    manifest_file,
    archive_file,
    projects_file,
    hot_dir,
    cold_dir,
    destination,
    supplement_file=None,
):
    package = Package(destination)
    manifest = bytes_from(manifest_file)
    source = json.loads(manifest)
    archive = bytes_from(archive_file)
    projects = json.loads(projects_file.read_bytes())
    require(source["version"] == 1, "Unknown legacy snapshot version")
    index = json.loads(archive)
    require(index["version"] == 1, "Unknown legacy archive version")
    source_rows = {r["path"]: r for r in source["entries"]}
    require(len(source_rows) == len(source["entries"]), "Duplicate legacy home paths")

    def read(h):
        p = hot_dir / hash_name(h)
        return (p if p.exists() else package.blobs / h).read_bytes()

    ledger = (
        json.loads(b"".join(file_bytes(source_rows[LEDGER], read)))
        if LEDGER in source_rows
        else {}
    )
    require(isinstance(ledger, dict), "Invalid cold ledger")
    layout = folder_layout(source["entries"], projects, ledger)
    supplement = json.loads(supplement_file.read_bytes()) if supplement_file else None
    for scope in (supplement or {}).get("scopes", {}):
        dog, folder = scope.split("/")
        key_for(dog, folder)
        if folder == "dog" and dog not in layout["dogs"]:
            layout["dogs"].append(dog)
        elif folder.startswith("task-") and folder[5:] not in layout["tasks"].get(
            dog, []
        ):
            key_for(dog, folder[5:])
            layout["tasks"].setdefault(dog, []).append(folder[5:])
    scopes, grouped, _ = split_entries(source["entries"], layout)
    package.metadata("source", digest(manifest))
    if supplement:
        require(
            supplement.get("v") == 1
            and supplement["baselineManifest"] == digest(manifest)
            and hash_name(supplement["census"]),
            "Supplement does not match the frozen legacy source",
        )
        require(
            set(supplement["scopes"]).issubset(scopes),
            "Supplemental root is absent from the authorized layout",
        )
    package.metadata("supplement", digest(encode(supplement)))
    package.metadata("archive", digest(archive))
    package.metadata("layout", layout)
    package.db.commit()
    for scope, folder in scopes.items():
        if package.db.execute(
            "SELECT 1 FROM scopes WHERE scope=?", (scope,)
        ).fetchone():
            continue
        rows = grouped[scope]
        if "/task-" in scope:
            dog, name = scope.split("/")
            key = dog + "/" + name[5:]
            if key in ledger:
                with tempfile.TemporaryDirectory(dir=destination) as scratch:
                    tar = pathlib.Path(scratch) / "original.tar"
                    sealed = archive_parts(
                        key,
                        ledger[key],
                        source_rows,
                        index["entries"],
                        read,
                        lambda h: (cold_dir / h).read_bytes(),
                        tar,
                    )
                    restored = scan_tar(tar, ledger[key], package.put_blob)
                    rows = merge_cold(rows, restored, ledger[key], read)
                    package.metadata("cold:" + scope, sealed)
        delta = (supplement or {}).get("scopes", {}).get(scope)
        if delta:
            if not folder and "" not in rows:
                rows[""] = {"type": "dir", "mode": 0o700}
            original_rows = hash_rows(rows, read)
            before = (
                canonical_digest(original_rows)
                if original_rows
                else digest(b"tombstone")
            )
            require(before == delta["baseTree"], "Supplemental source folder differs")
            package.build(
                scope, folder, rows, read, previous_version=True, deleted=not rows
            )
            changed = set()
            for change in delta["changes"]:
                path = change["path"]
                require(
                    (not path or path_name(path)) and path not in changed,
                    "Duplicate supplemental path",
                )
                changed.add(path)
                entry = change["entry"]
                if entry is None:
                    require(path in rows, "Cannot delete an unobserved source path")
                    del rows[path]
                else:
                    require(
                        entry["type"] in ("dir", "file", "link"),
                        "Invalid supplemental entry",
                    )
                    rows[path] = {**entry, "path": path}
            observed = (
                canonical_digest(hash_rows(rows, read))
                if rows
                else digest(b"tombstone")
            )
            require(
                observed == delta["resultTree"],
                "Supplemented tree does not match the frozen census",
            )
        package.build(scope, folder, rows, read, deleted=bool(delta and not rows))
    package.metadata("prepared", True)
    package.db.commit()
    return package
