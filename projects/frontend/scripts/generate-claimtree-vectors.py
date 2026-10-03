#!/usr/bin/env python3
"""Generate deterministic claim-tree test vectors for the frontend proof builder.

Drives docs/claim-tree-protocol-reference.py through a fixed pledge/null scenario and emits
`src/lib/claimtree.vectors.ts` (overwritten in place). Backers/amounts/txids are derived from
fixed seeds — no randomness — so regeneration is byte-identical.

Usage (from projects/frontend):  python3 scripts/generate-claimtree-vectors.py
"""

import base64
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
REF_PATH = ROOT / "docs" / "claim-tree-protocol-reference.py"
OUT_PATH = HERE.parent / "src" / "lib" / "claimtree.vectors.ts"

_spec = importlib.util.spec_from_file_location("claim_tree_ref", REF_PATH)
assert _spec is not None and _spec.loader is not None
ref = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ref)

H = lambda b: hashlib.new("sha512_256", b).digest()  # noqa: E731


def pubkey(name: str) -> bytes:
    return H(f"claimtree-backer-{name}".encode())


def address(pubkey: bytes) -> str:
    return base64.b32encode(pubkey + H(pubkey)[-4:]).decode().rstrip("=")


def txid(i: int) -> bytes:
    return H(f"claimtree-tx-{i}".encode())


# (backer_name, amount_microalgos) in append order; ('null', k) nulls position k.
SCRIPT: list = [
    ("pledge", "A", 3_000_000),
    ("pledge", "B", 1_000_000),
    ("pledge", "A", 2_000_000),
    ("pledge", "C", 1_000_000),
    ("pledge", "D", 5_000_000),
    ("pledge", "E", 500),
    ("pledge", "F", 7_000_000),
    ("pledge", "G", 250_000),
    ("null", 5),
    ("null", 0),
    ("null", 7),
    ("null", 3),
    ("pledge", "H", 1_000_000),
    ("pledge", "I", 4_000_000),
    ("null", 9),
    ("null", 1),
    ("null", 4),
]


def main() -> None:
    leaves: list = []
    raised = 0
    records: list = []
    steps: list = []
    tx_counter = 0
    for op in SCRIPT:
        if op[0] == "pledge":
            _, name, amount = op
            tx = txid(tx_counter)
            tx_counter += 1
            backer = pubkey(name)
            n = len(leaves)
            frontier = [p.hex() for p in ref.peaks(n, ref.build_nodes(leaves))]
            leaves, root, _ = ref.append(leaves, ref.leaf(backer, amount, tx))
            raised += amount
            records.append({"backer": backer, "amount": amount, "txid": tx})
            steps.append(
                {
                    "op": "append",
                    "backerPubkey": backer.hex(),
                    "backerAddress": address(backer),
                    "amount": str(amount),
                    "txid": tx.hex(),
                    "expect": {"n": len(leaves), "root": root.hex(), "raised": str(raised)},
                    "frontier": frontier,
                }
            )
        else:
            k = op[1]
            amount = records[k]["amount"]
            siblings, top, lower = ref.path_of(k, leaves)
            leaves, root, _ = ref.null(k, leaves)
            raised -= amount
            steps.append(
                {
                    "op": "null",
                    "k": k,
                    "amount": str(amount),
                    "path": {
                        "siblings": [s.hex() for s in siblings],
                        "top": top.hex() if top is not None else None,
                        "lower": [v.hex() for v in lower],
                    },
                    "expect": {"n": len(leaves), "root": root.hex(), "raised": str(raised)},
                }
            )
    payload = {
        "meta": {
            "hash": "sha512_256",
            "generator": "scripts/generate-claimtree-vectors.py (deterministic seeds, no randomness)",
            "leaf": "H(0x01 ‖ backer ‖ amount-be64 ‖ txid)",
        },
        "steps": steps,
    }
    header = (
        "/**\n"
        " * Committed claim-tree test vectors — DO NOT EDIT. Regenerate with:\n"
        " * `python3 scripts/generate-claimtree-vectors.py` (from projects/frontend).\n"
        " *\n"
        " * Each step drives docs/claim-tree-protocol-reference.py through a fixed pledge/null scenario. `backerAddress`\n"
        " * is the Algorand address of `backerPubkey` (checksum-validated by the spec); amounts/raised are decimal strings\n"
        " * so they survive JSON without precision loss. `frontier` is the pre-append frontier the pledge call takes;\n"
        " * `path` is the pre-null path the refund call takes.\n"
        " */\n"
        "export interface ClaimTreeVectorExpect {\n"
        "  n: number\n"
        "  root: string\n"
        "  raised: string\n"
        "}\n"
        "export interface ClaimTreeVectorAppendStep {\n"
        "  op: 'append'\n"
        "  backerPubkey: string\n"
        "  backerAddress: string\n"
        "  amount: string\n"
        "  txid: string\n"
        "  expect: ClaimTreeVectorExpect\n"
        "  frontier: string[]\n"
        "}\n"
        "export interface ClaimTreeVectorNullStep {\n"
        "  op: 'null'\n"
        "  k: number\n"
        "  amount: string\n"
        "  path: { siblings: string[]; top: string | null; lower: string[] }\n"
        "  expect: ClaimTreeVectorExpect\n"
        "}\n"
        "export type ClaimTreeVectorStep = ClaimTreeVectorAppendStep | ClaimTreeVectorNullStep\n"
        "export interface ClaimTreeVectorMeta {\n"
        "  hash: string\n"
        "  generator: string\n"
        "  leaf: string\n"
        "}\n"
        "export const CLAIM_TREE_VECTORS: { meta: ClaimTreeVectorMeta; steps: ClaimTreeVectorStep[] } = "
    )
    body = header + json.dumps(payload, indent=2) + " as const\n"
    OUT_PATH.write_text(body)
    print(f"wrote {OUT_PATH} ({len(steps)} steps)")


if __name__ == "__main__":
    sys.exit(main())
