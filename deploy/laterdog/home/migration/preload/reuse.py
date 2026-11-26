import argparse
import hashlib
import json
import os
import pathlib
import sqlite3


def digest(value):
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def require(value, message):
    if not value:
        raise ValueError(message)


def build(directory, destination):
    policy = json.loads((directory / "policy.json").read_bytes())
    receipt = json.loads((directory / "complete.json").read_bytes())
    catalog = policy["catalog"]
    require(
        receipt.get("verified") is True
        and receipt["catalogSha256"] == catalog
        and receipt["allowedWrites"] == ["blobs", "manifests", "summaries"],
        "Independent storage verification is incomplete",
    )
    require(
        all(receipt.get(k) == v for k, v in policy.items()),
        "The completion receipt belongs to another catalog",
    )
    source = sqlite3.connect(
        (directory / "readback.sqlite").absolute().as_uri() + "?mode=ro", uri=True
    )
    jobs = [
        json.loads(line)
        for line in (directory / "jobs.jsonl").read_bytes().splitlines()
    ]
    identity = digest([policy["account"], policy["bucket"], policy["stable"]])
    require(
        digest(
            [
                {k: v for k, v in policy.items() if k != "catalog"},
                [j["id"] for j in jobs],
            ]
        )
        == catalog,
        "Immutable source plan is inconsistent",
    )
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    out = sqlite3.connect(destination / "index.sqlite")
    try:
        with out:
            out.execute(
                "CREATE TABLE IF NOT EXISTS witnessed(origin TEXT,scope TEXT,op TEXT,kind TEXT,hash TEXT,PRIMARY KEY(origin,scope,op,kind,hash))"
            )
            n = 0
            for job in jobs:
                scope, objects, identifier = job["scope"], job["objects"], job["id"]
                require(
                    digest([scope, objects]) == identifier,
                    "Imported batch contents changed",
                )
                counts = source.execute(
                    "SELECT n FROM result WHERE catalog=? AND action='verify' AND id=?",
                    (catalog, identifier),
                ).fetchone()
                require(
                    counts and counts[0] == len(objects),
                    "The destination has no matching physical readback",
                )
                n += len(objects)
                out.executemany(
                    "INSERT OR IGNORE INTO witnessed VALUES(?,?,?,?,?)",
                    [
                        (identity, scope, op, kind, h)
                        for kind, h in objects
                        if kind in ("blobs", "manifests")
                        for op in ("put", "verify")
                    ],
                )
            require(n == receipt["objects"], "Incomplete verification set")
        records = out.execute(
            "SELECT count(*) FROM witnessed WHERE origin=? AND op='verify'", (identity,)
        ).fetchone()[0]
        return {
            "origin": identity,
            "catalog": catalog,
            "objects": n,
            "witnessed": records,
            "sourceReceipt": str(directory / "complete.json"),
        }
    finally:
        source.close()
        out.close()


def main():
    parser = argparse.ArgumentParser(
        description="Reuse only remotely verified folder blobs and manifests during the frozen delta."
    )
    parser.add_argument("directory", type=pathlib.Path)
    parser.add_argument("destination", type=pathlib.Path)
    args = parser.parse_args()
    os.umask(0o077)
    print(json.dumps(build(args.directory, args.destination)))


if __name__ == "__main__":
    main()
