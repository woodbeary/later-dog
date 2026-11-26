import argparse
import fcntl
import json
import os
import pathlib
from legacy import digest, require
from rollout import (
    activate,
    current_placement,
    fence,
    prepare_cutover,
    reconstruct,
    write_once,
)
from snapshot import Package, prepare
from transfer import Transport, preload, publish


def arguments():
    parser = argparse.ArgumentParser(
        description="Verify and migrate a home's working folders between saved formats."
    )
    parser.add_argument(
        "action",
        choices=[
            "prepare",
            "publish",
            "preload",
            "retain-legacy",
            "activate",
            "rollback",
            "abort",
            "repair-legacy",
        ],
    )
    parser.add_argument("--package", required=True, type=pathlib.Path)
    parser.add_argument("--hot", type=pathlib.Path, required=True)
    parser.add_argument("--archive-blobs", type=pathlib.Path)
    parser.add_argument("--manifest", type=pathlib.Path)
    parser.add_argument("--archive-index", type=pathlib.Path)
    parser.add_argument("--projects", type=pathlib.Path)
    parser.add_argument("--authority-file", type=pathlib.Path)
    parser.add_argument("--supplement", type=pathlib.Path)
    parser.add_argument("--reuse", type=pathlib.Path)
    parser.add_argument("--expected-heads", type=pathlib.Path)
    parser.add_argument("--journal", type=pathlib.Path)
    parser.add_argument("--workers", type=int, default=8)
    return parser.parse_args()


def main():
    os.umask(0o077)
    args = arguments()
    require(args.workers > 0, "At least one transfer worker is required")
    args.package.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.action == "prepare":
        require(
            all((args.manifest, args.archive_index, args.projects, args.archive_blobs)),
            "Legacy manifest, archive index, approved projects and blob sources are required",
        )
        package = prepare(
            args.manifest,
            args.archive_index,
            args.projects,
            args.hot,
            args.archive_blobs,
            args.package,
            args.supplement,
        )
        count, entries, size = package.db.execute(
            "SELECT count(*),sum(entries),sum(bytes) FROM scopes"
        ).fetchone()
        return {
            "scopes": count,
            "entries": entries,
            "bytes": size,
            "source": package.load("source"),
        }
    require(
        args.authority_file and args.authority_file.stat().st_mode & 0o077 == 0,
        "Use a private home-scoped authority file",
    )
    config = json.loads(args.authority_file.read_bytes())
    transport = Transport(
        config["origin"],
        config["bootstrap"],
        config["controlOrigin"],
        config["controlToken"],
        config.get("identity"),
    )
    if args.action in ("repair-legacy", "retain-legacy"):
        from retention import retain_snapshot
        from snapshot import bytes_from

        require(args.manifest, "A checksummed retained manifest is required")
        return retain_snapshot(
            transport,
            bytes_from(args.manifest),
            args.workers,
            args.action == "repair-legacy",
        )
    package = Package(args.package)
    folder = args.journal or args.package / "release"
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (folder / "process.lock").open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        if args.action == "preload":
            preload(package, args.hot, transport, args.workers, args.reuse)
            return {
                "source": package.load("source"),
                "objects": package.db.execute(
                    "SELECT count(*) FROM objects"
                ).fetchone()[0],
            }
        if args.action == "publish":
            expected = (
                json.loads(args.expected_heads.read_bytes())
                if args.expected_heads
                else None
            )
            claims = publish(
                package, args.hot, transport, args.workers, args.reuse, expected
            )
            write_once(
                folder / "published.json",
                {
                    "origin": transport.identity,
                    "source": package.load("source"),
                    "claims": claims,
                },
            )
            return {"scopes": len(claims), "source": package.load("source")}
        name = "rollback" if args.action == "rollback" else "activate"
        if args.action == "abort":
            pending = [
                item
                for item in ("activate", "rollback")
                if (folder / (item + ".json")).exists()
                and not (folder / (item + "-complete.json")).exists()
            ]
            require(
                len(pending) == 1,
                "There is no single unfinished placement change in this journal",
            )
            name = pending[0]
        path = folder / (name + ".json")
        projection = None
        if path.exists():
            plan = json.loads(path.read_bytes())
            if name == "rollback":
                meta = json.loads((folder / "legacy-source.json").read_bytes())
                projection = (
                    meta["sha256"],
                    meta["etag"],
                    (folder / "reconstructed.json").read_bytes(),
                )
        elif name == "activate" and args.action != "abort":
            receipt = json.loads((folder / "published.json").read_bytes())
            require(
                receipt["origin"] == transport.identity
                and receipt["source"] == package.load("source"),
                "Published receipt belongs to another source or home",
            )
            plan = prepare_cutover(
                "folders",
                package.authorized_layout(),
                receipt["source"],
                receipt["claims"],
                transport,
                path,
            )
        elif args.action == "rollback":
            layout, claims, projection = reconstruct(
                package, args.hot, transport, args.workers
            )
            old_sha, etag, raw = projection
            write_once(folder / "reconstructed.json", json.loads(raw))
            write_once(folder / "legacy-source.json", {"sha256": old_sha, "etag": etag})
            plan = prepare_cutover(
                "legacy", layout, digest(raw), claims, transport, path
            )
        else:
            raise ValueError("No recoverable release plan")
        if args.action == "abort":
            _, current, _ = current_placement(transport)
            require(
                current == plan["next"]["previous"],
                "The new placement was already published",
            )
            if projection:
                st, _, raw = transport.admin("manifest.json")
                require(
                    st == 200 and digest(raw) == projection[0],
                    "The compatible legacy projection has been written; resume its cutover",
                )
            fence(plan, transport, True, args.workers)
            return {"released": True}
        target = activate(plan, transport, args.workers, projection)
        write_once(folder / (name + "-complete.json"), {"placement": target})
        return {"placement": target, "mode": plan["next"]["mode"]}


if __name__ == "__main__":
    print(json.dumps(main()))
