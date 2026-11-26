import json
from legacy import digest, encode, hash_name, require
from transfer import decoded, parallel


def retain_snapshot(transport, data, workers, repair=False):
    source = digest(data)
    manifest = json.loads(data)
    require(manifest["version"] == 1, "Unsupported root manifest")
    chunks = [
        hash_name(h) for entry in manifest["entries"] for h in entry.get("chunks", [])
    ]
    groups = [chunks[n : n + 64] for n in range(0, len(chunks), 64)] or [[]]

    level = [digest(encode(["leaf", g])) for g in groups]
    branches = []
    while len(level) > 1:
        parents = [level[n : n + 64] for n in range(0, len(level), 64)]
        branches.append(parents)
        level = [digest(encode(["branch", g])) for g in parents]
    expected = {
        "snapshot": source,
        "root": level[0],
        "references": len(chunks),
        "unique": len(set(chunks)),
    }
    endpoint = "work-folders/retention/seal/" + source
    if not repair:
        status, _, sealed = transport.admin(endpoint, "POST", {"root": level[0]})
        if status == 200:
            require(
                decoded(status, sealed)["root"] == level[0],
                "Retained original checksum differs",
            )
            return expected
        require(status == 422, "Retained original could not be inspected")
    path = "work-folders/legacy-manifests/" + source
    if not repair:
        st, _, response = transport.admin(path, "PUT", data)
        require(
            decoded(st, response)["revision"] == source,
            "Legacy snapshot was not pinned",
        )

    def page(kind, group):
        h = digest(encode([kind, group]))
        method = "repair" if repair else kind
        st, _, response = transport.admin(
            "work-folders/retention/" + method + "/" + h, "POST", {"hashes": group}
        )
        require(
            decoded(st, response)["revision"] == h,
            "Legacy retention page acknowledgment differs",
        )
        return h

    parallel(groups, lambda g: page("leaf", g), workers)
    if not repair:
        for parents in branches:
            parallel(parents, lambda g: page("branch", g), workers)
    st, _, response = transport.admin(
        "work-folders/retention/seal/" + source, "POST", {"root": level[0]}
    )
    require(
        decoded(st, response)["root"] == level[0],
        "Legacy snapshot closure could not be verified",
    )
    return expected
