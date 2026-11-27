import base64
import concurrent.futures
import hashlib
import hmac
import http.client
import json
import sqlite3
import threading
import time
import urllib.parse
from legacy import CHUNK, digest, encode, hash_name, key_for, require


class Transport:
    def __init__(self, origin, bootstrap, control_origin, control_token, identity=None):
        self.origin = self.server(origin)
        self.control = self.server(control_origin)
        self.identity = identity or self.origin.geturl()
        self.bootstrap = bootstrap
        self.control_token = control_token
        self.local = threading.local()

    @staticmethod
    def server(origin):
        value = urllib.parse.urlsplit(origin)
        require(
            value.scheme == "https"
            or value.scheme == "http"
            and value.hostname in ("localhost", "127.0.0.1", "::1", "state.r2"),
            "Untrusted migration origin",
        )
        require(
            value.hostname
            and not (
                value.username
                or value.password
                or value.query
                or value.fragment
                or value.path.strip("/")
            ),
            "Invalid migration origin",
        )
        return value

    def request(self, server, path, token, method="GET", body=None, headers=None):
        payload = body if isinstance(body, bytes) or body is None else encode(body)
        for attempt in range(6):
            hosts = getattr(self.local, "hosts", {})
            self.local.hosts = hosts
            conn = hosts.get(server)
            if conn is None:
                connection = (
                    http.client.HTTPSConnection
                    if server.scheme == "https"
                    else http.client.HTTPConnection
                )
                conn = hosts[server] = connection(
                    server.hostname, server.port, timeout=120
                )
            try:
                conn.request(
                    method,
                    path,
                    payload,
                    {
                        "authorization": "Bearer " + token,
                        "content-type": "application/octet-stream",
                        **(headers or {}),
                    },
                )
                response = conn.getresponse()
                result = (
                    response.status,
                    dict((k.lower(), v) for k, v in response.getheaders()),
                    response.read(),
                )
                if (
                    response.status not in (408, 425, 429, 500, 502, 503, 504)
                    or attempt == 5
                ):
                    return result
            except (OSError, http.client.HTTPException):
                if attempt == 5:
                    raise
            conn.close()
            hosts.pop(server, None)
            time.sleep(min(10, 0.25 * 2**attempt))
        raise RuntimeError("Unreachable transfer state")

    def folder(self, scope, path, method="GET", body=None):
        dog, folder = scope.split("/")
        key_for(dog, folder)
        token = (
            "wfa_"
            + hmac.new(
                self.bootstrap.encode(),
                ("laterdog-work-folder-v1\n" + dog + "\n" + folder).encode(),
                hashlib.sha256,
            ).hexdigest()
        )
        return self.request(
            self.origin,
            "/api/work-folders/v1/" + scope + "/" + path,
            token,
            method,
            body,
        )

    def admin(self, path, method="GET", body=None, headers=None):
        return self.request(
            self.control, "/" + path, self.control_token, method, body, headers
        )

    def head(self, scope):
        status, _, raw = self.folder(scope, "head")
        if status == 404:
            require(
                json.loads(raw).get("error") == "never_published",
                "Missing endpoint cannot prove an absent folder",
            )
            return None
        return decoded(status, raw)

    def object(self, scope, kind, identity):
        status, _, data = self.folder(scope, kind + "/" + hash_name(identity))
        require(
            status == 200 and len(data) <= CHUNK and digest(data) == identity,
            "Missing or damaged immutable folder object",
        )
        return data


def decoded(status, raw):
    if not 200 <= status < 300:
        raise RuntimeError(
            f"Folder operation returned {status}: " + raw[:200].decode(errors="replace")
        )
    return json.loads(raw)


def batch(transport, scope, action, group):
    if action == "put" and len(group) == 1 and len(group[0][2]) > 4 * 1024 * 1024:
        kind, h, data = group[0]
        status, _, raw = transport.folder(scope, kind + "/" + h, "PUT", data)
        require(200 <= status < 300, f"Large content upload returned {status}")
        return
    objects = []
    for kind, h, data in group:
        item = {"kind": kind, "sha256": h}
        if action == "put":
            item["base64"] = base64.b64encode(data).decode()
        objects.append(item)
    status, _, raw = transport.folder(
        scope, "batch", "POST", {"op": action, "objects": objects}
    )
    if (
        action == "verify"
        and status == 404
        and json.loads(raw).get("error") == "Missing verification object"
    ):
        raise FileNotFoundError("Acknowledged working folder object is missing")
    require(
        decoded(status, raw)["verified"] == [o["sha256"] for o in objects],
        "Batch acknowledgment differs",
    )


def groups(rows, read, action, rank):
    group = []
    size = 0
    limit = 8 if 64 <= rank < 128 else 48
    for kind, h in rows:
        data = read(kind, h) if action == "put" else b""
        if group and (len(group) >= limit or size + len(data) > 3 * 1024 * 1024):
            yield group
            group, size = [], 0
        group.append((kind, h, data))
        size += len(data)
    if group:
        yield group


def parallel(items, fn, workers):
    with concurrent.futures.ThreadPoolExecutor(workers) as pool:
        pending = set()
        for item in items:
            pending.add(pool.submit(fn, item))
            if len(pending) >= workers:
                done, pending = concurrent.futures.wait(
                    pending, return_when=concurrent.futures.FIRST_COMPLETED
                )
                for result in done:
                    result.result()
        for result in concurrent.futures.as_completed(pending):
            result.result()


def preload(package, hot, transport, workers, reuse=None):
    require(package.load("prepared"), "Package preparation is incomplete")
    package.db.execute(
        "CREATE TABLE IF NOT EXISTS receipts(origin TEXT,scope TEXT,op TEXT,hash TEXT,PRIMARY KEY(origin,scope,op,hash))"
    )
    package.db.execute(
        "CREATE TABLE IF NOT EXISTS witnessed(origin TEXT,scope TEXT,op TEXT,kind TEXT,hash TEXT,PRIMARY KEY(origin,scope,op,kind,hash))"
    )
    destination = transport.identity
    if reuse:
        other = (reuse / "index.sqlite").resolve()
        require(
            other.exists() and other != (package.directory / "index.sqlite").resolve(),
            "Invalid previous package",
        )
        package.db.execute(
            "ATTACH DATABASE ? AS previous", (other.as_uri() + "?mode=ro",)
        )
        package.db.execute(
            "INSERT OR IGNORE INTO witnessed SELECT origin,scope,op,kind,hash FROM previous.witnessed WHERE origin=?",
            (destination,),
        )
        package.db.commit()
        package.db.execute("DETACH DATABASE previous")
    lock = threading.Lock()

    def local(kind, h):
        if kind == "manifests":
            return package.db.execute(
                "SELECT data FROM nodes WHERE hash=?", (h,)
            ).fetchone()[0]
        path = hot / h
        data = (path if path.exists() else package.blobs / h).read_bytes()
        require(digest(data) == h, "Prepared bytes changed")
        return data

    def queue(op, rank):
        for (scope,) in package.db.execute(
            "SELECT DISTINCT scope FROM objects WHERE rank=? ORDER BY scope", (rank,)
        ):
            entries = package.db.execute(
                "SELECT o.kind,o.hash FROM objects o WHERE o.scope=? AND o.rank=? AND NOT EXISTS (SELECT 1 FROM witnessed w WHERE w.origin=? AND w.scope=o.scope AND w.op=? AND w.kind=o.kind AND w.hash=o.hash) ORDER BY o.kind,o.hash",
                (scope, rank, destination, op),
            )
            for group in groups(entries, local, op, rank):
                identity = digest(encode([[kind, h] for kind, h, _ in group]))
                if package.db.execute(
                    "SELECT 1 FROM receipts WHERE origin=? AND scope=? AND op=? AND hash=?",
                    (destination, scope, op, identity),
                ).fetchone():
                    continue
                yield scope, group, identity

    def execute(item):
        scope, group, identity = item
        try:
            batch(transport, scope, op, group)
        except FileNotFoundError:
            require(
                op == "verify",
                "Expected an acknowledged upload before checking presence",
            )
            with lock:
                restored = []
                for kind, h, _ in group:
                    if kind == "manifests":
                        data = receipt_db.execute(
                            "SELECT data FROM nodes WHERE hash=?", (h,)
                        ).fetchone()[0]
                    else:
                        file = hot / h
                        data = (
                            file if file.exists() else package.blobs / h
                        ).read_bytes()
                    require(digest(data) == h, "Prepared repair bytes changed")
                    restored.append((kind, h, data))
            for kind, h, data in restored:
                batch(transport, scope, "put", [(kind, h, data)])
            batch(transport, scope, "verify", group)
        with lock:
            receipt_db.execute(
                "INSERT OR IGNORE INTO receipts VALUES(?,?,?,?)",
                (destination, scope, op, identity),
            )
            receipt_db.executemany(
                "INSERT OR IGNORE INTO witnessed VALUES(?,?,?,?,?)",
                [(destination, scope, op, kind, h) for kind, h, _ in group],
            )
            receipt_db.commit()

    receipt_db = sqlite3.connect(
        package.directory / "index.sqlite", timeout=60, check_same_thread=False
    )
    ranks = [
        r[0]
        for r in package.db.execute("SELECT DISTINCT rank FROM objects ORDER BY rank")
    ]
    try:
        for rank in ranks:
            for op in ("put", "verify"):
                parallel(queue(op, rank), execute, workers)
    finally:
        receipt_db.close()


def publish(package, hot, transport, workers, reuse=None, expected=None):
    preload(package, hot, transport, workers, reuse)
    status, _, placement_bytes = transport.admin("work-folders/placement")
    active = False
    if status == 404:
        require(
            json.loads(placement_bytes).get("error") == "not_found",
            "Unknown placement namespace",
        )
        historic = {}
    else:
        placement = decoded(status, placement_bytes)
        active = placement["mode"] == "folders"
        st, _, proof = transport.admin(
            "work-folders/verification/" + hash_name(placement["verification"])
        )
        require(
            st == 200 and digest(proof) == placement["verification"],
            "Missing verified prior layout",
        )
        historic = {s["scope"]: s for s in json.loads(proof)["scopes"]}

    if expected:
        require(
            not active and expected["origin"] == transport.identity,
            "Expected heads belong to another home or the home is already active",
        )
        for old in expected["claims"]:
            st, _, bytes_of_version = transport.folder(
                old["scope"], "versions/" + hash_name(old["revision"])
            )
            verified = decoded(st, bytes_of_version)
            require(
                verified["revision"] == old["revision"]
                and verified["manifest"] == old["manifest"],
                "Prior staging receipt differs from recorded history",
            )
            historic[old["scope"]] = old

    def preserved(scope, prior, manifest):
        revision = prior["revision"] if prior else None
        visited = set()
        while revision:
            require(revision not in visited, "Working folder version history is cyclic")
            visited.add(revision)
            st, _, raw = transport.folder(scope, "versions/" + hash_name(revision))
            version = decoded(st, raw)
            parent, saved = version["parent"], version["manifest"]
            require(version["revision"] == revision == digest(encode([1, parent, saved])), "Stored working folder version changed")
            if saved == manifest:
                return True
            revision = parent
        return False

    def install(scope, parent, manifest):
        st, _, raw = transport.folder(
            scope, "migration-commit", "POST", {"parent": parent, "manifest": manifest}
        )
        return decoded(st, raw)["revision"]

    claims = []
    for scope, target, source_tree in package.db.execute(
        "SELECT scope,root,source FROM scopes ORDER BY scope"
    ):
        original = package.db.execute(
            "SELECT root,source FROM originals WHERE scope=?", (scope,)
        ).fetchone()
        prior = historic.get(scope)
        parent = prior["revision"] if prior else None
        prior_manifest = prior["manifest"] if prior else None
        if not active and original and original[0]:
            if prior_manifest != original[0] and not preserved(scope, prior, original[0]):
                parent = install(scope, parent, original[0])
                prior_manifest = original[0]
            require(
                read_tree(transport, scope, original[0], package)["checksum"]
                == original[1],
                "Original superseded working copy differs",
            )
        target = target or None
        if active:
            require(
                prior and target == prior_manifest,
                "Cannot replace an active working folder from an old legacy snapshot",
            )
        revision = (
            parent
            if parent is not None and target == prior_manifest
            else install(scope, parent, target)
        )
        head = transport.head(scope)
        require(
            head and head["manifest"] == target and head["revision"] == revision,
            "A different working copy was already published",
        )
        tree = read_tree(transport, scope, target, package)
        require(
            tree["checksum"] == source_tree,
            "Remote inventory differs from legacy source",
        )
        claims.append(
            {
                "scope": scope,
                "revision": head["revision"],
                "manifest": target,
                "sourceTree": source_tree,
                "restoredTree": tree["checksum"],
            }
        )
    return claims


def read_tree(transport, scope, manifest, package=None, fetch_unknown=None):
    from snapshot import canonical_digest

    if manifest is None:
        return {"rows": {}, "checksum": digest(b"tombstone"), "hashes": set()}
    verified = set()

    def node(h):
        hash_name(h)
        found = None
        if package:
            found = package.db.execute(
                "SELECT n.data FROM nodes n JOIN objects o ON n.hash=o.hash WHERE o.scope=? AND o.kind='manifests' AND o.hash=?",
                (scope, h),
            ).fetchone()
        data = found[0] if found else transport.object(scope, "manifests", h)
        require(digest(data) == h, "Manifest checksum differs")
        val = json.loads(data)
        require(val["v"] == 1, "Unknown work folder manifest")
        return val

    def leaves(h, kind, depth=0):
        require(depth < 64, "Invalid manifest depth")
        current = node(h)
        if current["kind"] == kind:
            yield from current["entries" if kind == "entries" else "hashes"]
        else:
            require(
                current["kind"] == "pages" and current["of"] == kind,
                "Manifest page kind differs",
            )
            for child in current["children"]:
                yield from leaves(child, kind, depth + 1)

    if transport:
        remote_root = transport.object(scope, "manifests", manifest)
        require(
            json.loads(remote_root) == node(manifest),
            "Published root differs from verified local content",
        )
    root = node(manifest)
    require(root["kind"] == "root", "Invalid folder root")
    from legacy import mode_time, path_name

    rows = {"": {"type": "dir", **mode_time(root)}}
    for entry in leaves(root["entries"], "entries"):
        path = path_name(entry["path"])
        parent = path.rpartition("/")[0]
        require(
            path not in rows and rows.get(parent, {}).get("type") == "dir",
            "Invalid folder parent or duplicate",
        )
        kind = entry["kind"]
        row = {"type": kind, **mode_time({**entry, "mode": entry.get("mode", 0o777)})}
        if kind == "file":
            chunks = list(leaves(entry["contents"], "chunks"))
            for h in chunks:
                verified.add(hash_name(h))
            if fetch_unknown is not None:
                full = hashlib.sha256()
                count = 0
                for h in chunks:
                    b = fetch_unknown(h)
                    require(digest(b) == h, "File blob checksum differs")
                    full.update(b)
                    count += len(b)
                require(
                    count == entry["size"] and full.hexdigest() == entry["sha256"],
                    "File contents differ from declared checksum",
                )
            row.update(
                size=entry["size"], chunks=chunks, sha256=hash_name(entry["sha256"])
            )
            if "hardlink" in entry:
                target = path_name(entry["hardlink"])
                prior = rows.get(target)
                require(
                    prior
                    and target < path
                    and "hardlink" not in prior
                    and all(
                        prior.get(k) == row.get(k)
                        for k in ("type", "size", "chunks", "sha256", "mode", "mtimeMs")
                    ),
                    "Hard link differs from its named file",
                )
                row["hardlink"] = target
        elif kind == "link":
            row["target"] = entry["target"]
        else:
            require(kind == "dir", "Unexpected manifest entry type")
        rows[path] = row
    return {"rows": rows, "checksum": canonical_digest(rows), "hashes": verified}
