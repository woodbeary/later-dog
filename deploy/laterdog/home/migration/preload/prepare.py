import argparse
import hashlib
import json
import os
import pathlib
import re
import sqlite3


def encoded(item):
    return json.dumps(item, separators=(",", ":"), ensure_ascii=False).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    p = argparse.ArgumentParser(
        description="Prepare a tenant-scoped, immutable-only Cloudflare folder copy"
    )
    for key in ["package", "output", "forward"]:
        p.add_argument("--" + key, required=True, type=pathlib.Path)
    for key in [
        "service",
        "account",
        "bucket",
        "stable",
        "source-bucket",
        "source-stable",
    ]:
        p.add_argument("--" + key, required=True)
    p.add_argument("--fixture", action="store_true")
    a = p.parse_args()
    os.umask(0o077)
    assert all(re.fullmatch("[a-f0-9]{64}", s) for s in (a.stable, a.source_stable))
    assert re.fullmatch("[a-f0-9]{32}", a.account) and all(
        re.fullmatch("[a-z0-9-]{3,63}", n)
        for n in (a.service, a.bucket, a.source_bucket)
    )
    assert (a.bucket, a.stable) != (a.source_bucket, a.source_stable)
    if a.fixture:
        assert a.bucket == a.source_bucket and a.bucket != "laterdog-homes"
    proof = json.loads(a.forward.read_bytes())
    assert (
        digest(encoded(proof["proof"])) == proof["next"]["verification"]
        and proof["proof"]["mode"] == "folders"
    )
    db = sqlite3.connect(
        (a.package / "index.sqlite").absolute().as_uri() + "?mode=ro", uri=True
    )
    checked = {
        r["scope"]: (r["manifest"] or "", r["sourceTree"])
        for r in proof["proof"]["scopes"]
        if r["restoredTree"] == r["sourceTree"]
    }
    assert checked == {
        s: (m, t) for s, m, t in db.execute("SELECT scope,root,source FROM scopes")
    }
    jobs = []
    count = 0
    for scope in sorted(checked):
        rows = []
        for kind, h in db.execute(
            "SELECT kind,hash FROM objects WHERE scope=? ORDER BY rank, kind, hash",
            (scope,),
        ):
            assert kind in ("blobs", "manifests") and re.fullmatch("[a-f0-9]{64}", h)
            rows.append([kind, h])
            if kind == "manifests":
                rows.append(["summaries", h])
        if a.fixture:
            rows = rows[:3] + [row for row in rows if row[0] != "blobs"][:3]
            rows = list({tuple(row): row for row in rows}.values())
        for i in range(0, len(rows), 48):
            batch = rows[i : i + 48]
            jobs.append(
                {
                    "id": digest(encoded([scope, batch])),
                    "scope": scope,
                    "objects": batch,
                }
            )
            count += len(batch)
        if a.fixture and len(jobs) >= 5:
            break
    batches = [j["id"] for j in jobs]
    info = {
        "v": 1,
        "action": "immutable-folder-preload",
        "account": a.account,
        "bucket": a.bucket,
        "stable": a.stable,
        "sourceBucket": a.source_bucket,
        "sourceStable": a.source_stable,
        "service": a.service,
        "sourceVerification": proof["next"]["verification"],
        "objects": count,
        "scopes": len({j["scope"] for j in jobs}),
        "fixture": a.fixture,
    }
    catalog = digest(encoded([info, batches]))
    policy = {**info, "catalog": catalog}
    a.output.mkdir(parents=True, exist_ok=True, mode=0o700)

    def write(name, data):
        path = a.output / name
        if path.exists():
            assert path.read_bytes() == data, "Existing copy plan differs"
        else:
            path.write_bytes(data)

    write("catalog.generated.json", encoded({**policy, "batches": batches}))
    write("policy.json", encoded(policy))
    write("jobs.jsonl", b"".join(encoded(j) + b"\n" for j in jobs))
    write("worker.mjs", pathlib.Path(__file__).with_name("worker.mjs").read_bytes())
    common = {"account_id": a.account, "compatibility_date": "2026-10-01"}
    write(
        "worker.json",
        encoded(
            {
                **common,
                "name": a.service,
                "main": "worker.mjs",
                "workers_dev": False,
                "preview_urls": False,
                "routes": [],
                "r2_buckets": [
                    {"binding": "SOURCE", "bucket_name": a.source_bucket},
                    {"binding": "DESTINATION", "bucket_name": a.bucket},
                ],
            }
        ),
    )
    write(
        "local.json",
        encoded(
            {
                **common,
                "name": a.service + "-mac",
                "services": [
                    {
                        "binding": "COPY",
                        "service": a.service,
                        "entrypoint": "ImmutableFolderCopy",
                        "remote": True,
                    }
                ],
            }
        ),
    )
    print(json.dumps({**policy, "batches": len(jobs)}))


if __name__ == "__main__":
    main()
