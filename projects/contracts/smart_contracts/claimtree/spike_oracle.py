#!/usr/bin/env python3
"""Stateful CLI wrapper around the Claim Tree reference oracle.

Lets the LocalNet spike test drive `docs/claim-tree-protocol-reference.py` step by step with REAL on-chain payment TxIDs:
state (leaf records + raised) persists in a JSON file between invocations, so TypeScript only does IO while all tree math
stays in the independent Python implementation.

Usage:  spike_oracle.py STATE CMD [args...]     (prints one JSON object to stdout)

    init                                        reset state to the empty tree
    frontier                                    current {n, peaks[]} (ascending level, hex)
    append BACKER_HEX AMOUNT TXID_HEX           append one leaf -> {n, root, raised}
    path K                                      auth path + leaf record for K -> {siblings[], top|null, lower[], root, backer, amount, txid}
    null K AMOUNT                                null position K -> {n, root, raised}
    state                                       current {n, root, raised}
"""

import importlib.util
import json
import sys
from pathlib import Path

REF_PATH = Path(__file__).resolve().parent.parent.parent.parent.parent / "docs" / "claim-tree-protocol-reference.py"
_spec = importlib.util.spec_from_file_location("claim_tree_ref", REF_PATH)
assert _spec is not None and _spec.loader is not None
ref = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ref)


def load(state_path: Path) -> dict:
    if state_path.exists():
        return json.loads(state_path.read_text())
    return {"leaves": [], "raised": 0}


def save(state_path: Path, state: dict) -> None:
    state_path.write_text(json.dumps(state))


def values(state: dict) -> list:
    """Current leaf values (live leaves or Z), position order."""
    return [bytes.fromhex(r["v"]) for r in state["leaves"]]


def main() -> None:
    state_path = Path(sys.argv[1])
    cmd = sys.argv[2]
    state = load(state_path)
    leaves = values(state)

    if cmd == "init":
        state = {"leaves": [], "raised": 0}
        print(json.dumps({"n": 0, "root": ref.Z.hex(), "raised": 0}))
    elif cmd == "frontier":
        n = len(leaves)
        print(json.dumps({"n": n, "peaks": [p.hex() for p in ref.peaks(n, ref.build_nodes(leaves))] if n else []}))
        return
    elif cmd == "append":
        backer, amount, txid = bytes.fromhex(sys.argv[3]), int(sys.argv[4]), bytes.fromhex(sys.argv[5])
        new_leaves, new_root, _ = ref.append(leaves, ref.leaf(backer, amount, txid))
        records = [
            {"v": v.hex(), "backer": sys.argv[3], "amount": amount, "txid": sys.argv[5]} if i == len(leaves) else r
            for i, (v, r) in enumerate(zip(new_leaves, state["leaves"] + [None]))
        ]
        state = {"leaves": records, "raised": state["raised"] + amount}
        print(json.dumps({"n": len(new_leaves), "root": new_root.hex(), "raised": state["raised"]}))
    elif cmd == "path":
        k = int(sys.argv[3])
        siblings, top, lower = ref.path_of(k, leaves)
        rec = state["leaves"][k]
        print(
            json.dumps(
                {
                    "siblings": [s.hex() for s in siblings],
                    "top": top.hex() if top is not None else None,
                    "lower": [v.hex() for v in lower],
                    "root": ref.root_of(leaves).hex(),
                    "backer": rec["backer"],
                    "amount": rec["amount"],
                    "txid": rec["txid"],
                }
            )
        )
        return
    elif cmd == "null":
        k, amount = int(sys.argv[3]), int(sys.argv[4])
        new_leaves, new_root, _ = ref.null(k, leaves)
        records = [
            {"v": v.hex(), "backer": r["backer"], "amount": r["amount"], "txid": r["txid"]}
            for v, r in zip(new_leaves, state["leaves"])
        ]
        state = {"leaves": records, "raised": state["raised"] - amount}
        print(json.dumps({"n": len(new_leaves), "root": new_root.hex(), "raised": state["raised"]}))
    elif cmd == "state":
        print(json.dumps({"n": len(leaves), "root": ref.root_of(leaves).hex(), "raised": state["raised"]}))
        return
    else:
        raise SystemExit(f"unknown command: {cmd}")
    save(state_path, state)


if __name__ == "__main__":
    main()
