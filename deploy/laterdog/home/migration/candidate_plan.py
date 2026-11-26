import argparse
import gzip
import json
import os
import pathlib
import tempfile
from legacy import digest, encode, hash_name, require
from rollout import write_once
from snapshot import Package
from transfer import Transport, decoded, parallel, read_tree


def immutable(path, data):
    name = digest(data)
    output = path / name
    if not output.exists():
        with tempfile.NamedTemporaryFile(dir=path, delete=False) as tmp:
            tmp.write(data)
            tmp.flush()
            os.fsync(tmp.fileno())
        try:
            try:
                os.link(tmp.name, output)
            except FileExistsError:
                pass
        finally:
            os.unlink(tmp.name)
    require(output.read_bytes() == data, "Conflicting candidate plan bytes")
    return name


def pack(package, forward, directory):
    verification = hash_name(forward["next"]["verification"])
    proof = forward["proof"]
    require(
        proof["mode"] == "folders" and digest(encode(proof)) == verification,
        "The forward migration proof changed",
    )
    require(
        proof["baselineManifest"] == forward["next"]["baselineManifest"],
        "Candidate source differs from verification",
    )
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    installed = {
        s: (root or None, tree)
        for s, root, tree in package.db.execute("SELECT scope,root,source FROM scopes")
    }
    require(
        len(proof["scopes"]) == len(installed)
        and {r["scope"] for r in proof["scopes"]} == set(installed),
        "Candidate folder membership differs from the sealed source",
    )
    index = []
    allowed = {
        "dir": {"mode", "mtimeMs"},
        "link": {"mode", "mtimeMs", "target"},
        "file": {"mode", "mtimeMs", "size", "sha256", "chunks", "hardlink"},
    }
    for claim in sorted(proof["scopes"], key=lambda c: c["scope"]):
        scope = claim["scope"]
        manifest, tree = installed[scope]
        require(
            manifest == claim["manifest"]
            and tree == claim["sourceTree"] == claim["restoredTree"],
            "Candidate expected revision differs from the source package",
        )
        inventory = read_tree(None, scope, manifest, package)
        require(
            inventory["checksum"] == tree,
            "Candidate metadata failed the source checksum",
        )
        rows = []
        files = 0
        total = 0
        for name, details in sorted(inventory["rows"].items()):
            kind = details["type"]
            require(
                set(details) <= allowed[kind] | {"type"},
                "Unexpected candidate metadata",
            )
            if kind == "file":
                files += 1
                total += details["size"]
            rows.append({"path": name, **details})
        revision = hash_name(claim["revision"])
        key = {"scope": scope, "revision": revision, "manifest": manifest, "tree": tree}
        raw = encode({"v": 1, "verification": verification, **key, "rows": rows})
        packed = gzip.compress(raw, compresslevel=6, mtime=0)
        packed = packed[:9] + bytes([255]) + packed[10:]
        sha256 = immutable(directory, packed)
        index.append(
            {
                **key,
                "entries": max(0, len(rows) - 1),
                "files": files,
                "bytes": total,
                "sha256": sha256,
                "packedBytes": len(packed),
            }
        )
    terms = {"v": 1, "verification": verification, "scopes": index}
    packed = encode(terms)
    index_hash = immutable(directory, packed)
    receipt = {
        "v": 1,
        "verification": verification,
        "index": index_hash,
        "scopes": len(index),
        "entries": sum(r["entries"] for r in index),
        "files": sum(r["files"] for r in index),
        "bytes": sum(r["bytes"] for r in index),
        "packedBytes": sum(r["packedBytes"] for r in index),
    }
    write_once(directory / "index.json", receipt)
    return receipt


def upload(receipt, directory, transport, workers):
    verification = hash_name(receipt["verification"])
    index_hash = hash_name(receipt["index"])
    data = (directory / index_hash).read_bytes()
    require(digest(data) == index_hash, "Candidate index changed")
    index = json.loads(data)
    require(index["verification"] == verification, "Candidate verification changed")

    def send(identity):
        h = hash_name(identity)
        raw = (directory / h).read_bytes()
        require(digest(raw) == h, "Candidate bytes changed before upload")
        path = "work-folders/cutover-plans/" + verification + "/" + h
        status, _, body = transport.admin(path, "PUT", raw)
        require(
            decoded(status, body)["sha256"] == h,
            "Candidate publication was not acknowledged",
        )
        status, _, body = transport.admin(path)
        require(
            status == 200 and digest(body) == h and body == raw,
            "Candidate publication readback differs",
        )

    parallel((row["sha256"] for row in index["scopes"]), send, workers)
    send(index_hash)
    return {**receipt, "verified": True, "origin": transport.identity}


def main():
    parser = argparse.ArgumentParser(
        description="Pack and publish checksum-verified candidate folder metadata."
    )
    parser.add_argument("action", choices=("pack", "upload"))
    parser.add_argument("--directory", required=True, type=pathlib.Path)
    parser.add_argument("--forward", type=pathlib.Path)
    parser.add_argument("--package", type=pathlib.Path)
    parser.add_argument("--authority-file", type=pathlib.Path)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == "pack":
        require(
            args.forward and args.package,
            "Forward plan and checked source package are required",
        )
        return pack(
            Package(args.package), json.loads(args.forward.read_bytes()), args.directory
        )
    require(
        args.workers > 0
        and args.authority_file
        and args.authority_file.stat().st_mode & 0o077 == 0,
        "Private scoped authority is required",
    )
    config = json.loads(args.authority_file.read_bytes())
    transport = Transport(
        config["origin"],
        config["bootstrap"],
        config["controlOrigin"],
        config["controlToken"],
        config.get("identity"),
    )
    return upload(
        json.loads((args.directory / "index.json").read_bytes()),
        args.directory,
        transport,
        args.workers,
    )


if __name__ == "__main__":
    print(json.dumps(main()))
