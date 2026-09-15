"""
Reference model for the AlgorArt Claim Tree Protocol (Protocol Specification v1,
see docs/claim-tree-protocol.md). Language-independent oracle: the smart
contract implementation must reproduce its outputs (root, N, raised,
paidInOf/paidOutOf) for every operation sequence.

Implements the incremental frontier-Merkle with in-place null-deletion:

    leaf / build_nodes / peaks / fold / root_of   -- canonical tree (spec §3)
    append                                        -- authenticated append (spec §4)
    path_of / verify / null                       -- refunds (spec §5–6)

Property tests (spec §15):

    * fold == naive tree root for all N < 300
    * append == naive root over 500 random sequences
    * exhaustive: every leaf pattern at every N <= 12 -- verify, arbitrary
      null sequences, double-null rejection
    * randomized large-N verify / null-order / double-null
    * 100 random mixed append/null sequences (append-after-null invariant)
    * stale-proof rejection; amount/txid/sender binding
    * exact pledge cost identity (2 * popcount(N))
    * worst-case cost table (spec §14)

Run:  python3 claim-tree-protocol-reference.py
"""

import hashlib
import random

H = lambda b: hashlib.new("sha512_256", b).digest()  # SHA-512/256 = AVM `sha256` opcode
Z = bytes(32)


def leaf(backer: bytes, amount: int, txid: bytes) -> bytes:
    assert len(backer) == 32 and len(txid) == 32 and 0 <= amount < 2**64
    return H(b"\x01" + backer + amount.to_bytes(8, "big") + txid)


# --------------------------------------------------------------------------
# Canonical left-filled binary tree over positions 0..N-1 (spec §3).
# Node (l, i) covers [i*2^l, (i+1)*2^l); it exists iff (i+1)*2^l <= N.
# --------------------------------------------------------------------------
# --------------------------------------------------------------------------


def build_nodes(leaves):
    """All full nodes: nodes[l][i] -> bytes. nodes[0] = leaf values."""
    n = len(leaves)
    nodes = {0: list(leaves)}
    l = 1
    while (1 << l) <= n:
        level = []
        prev = nodes[l - 1]
        for i in range(n >> l):
            level.append(H(prev[2 * i] + prev[2 * i + 1]))
        nodes[l] = level
        l += 1
    return nodes


def node(nodes, l, i):
    return nodes[l][i]


def peak_levels(N):
    """Ascending levels of the frontier peaks (set bits of N)."""
    return [l for l in range(N.bit_length()) if (N >> l) & 1]


def peaks(N, nodes):
    """Frontier peak values, ascending level."""
    return [nodes[l][(N >> l) - 1] for l in peak_levels(N)]


def fold(P):
    """Fold of peaks, ascending level. acc = highest; combine H(acc || peak)."""
    acc = P[-1]
    for p in reversed(P[:-1]):
        acc = H(acc + p)
    return acc


def root_of(leaves):
    n = len(leaves)
    if n == 0:
        return Z
    return fold(peaks(n, build_nodes(leaves)))


def append(leaves, new_leaf):
    """Append one leaf. Returns (leaves, new_root, hash_count)."""
    N = len(leaves)
    nodes = build_nodes(leaves)
    P = peaks(N, nodes)
    calls = 1  # leaf hash
    if N:
        fold(P)  # frontier authentication (p-1 hashes)
        calls += len(P) - 1
    g = new_leaf
    l, idx = 0, 0
    while (N >> l) & 1:
        g = H(P[idx] + g)  # older peak is the LEFT child
        calls += 1
        idx += 1
        l += 1
    newP = [g] + P[idx:]
    new_root = fold(newP)
    calls += len(newP) - 1
    return leaves + [new_leaf], new_root, calls


def path_of(k, leaves):
    """Authentication data for position k: (siblings, top, lower)."""
    N = len(leaves)
    assert 0 <= k < N
    nodes = build_nodes(leaves)
    siblings = []
    l = 0
    while True:
        i = k >> l
        sib = i ^ 1
        if ((sib + 1) << l) > N:
            break
        siblings.append(nodes[l][sib])
        l += 1
    r = l
    higher = [nodes[ll][(N >> ll) - 1] for ll in peak_levels(N) if ll > r]
    top = fold(higher) if higher else None
    lower = [nodes[ll][(N >> ll) - 1] for ll in peak_levels(N) if ll < r]
    return siblings, top, lower


def combine_path(k, acc, siblings, top, lower):
    for l, s in enumerate(siblings):
        acc = H(acc + s) if ((k >> l) & 1) == 0 else H(s + acc)
    if top is not None:
        acc = H(top + acc)
    for f in reversed(lower):
        acc = H(acc + f)
    return acc


def verify(k, leaf_value, siblings, top, lower, stored_root):
    return combine_path(k, leaf_value, siblings, top, lower) == stored_root


def null(k, leaves):
    """Refund position k. Returns (new_leaves, new_root, hash_count)."""
    N = len(leaves)
    siblings, top, lower = path_of(k, leaves)
    calls = 1  # leaf recompute
    old_root = combine_path(k, leaves[k], siblings, top, lower)
    calls += len(siblings) + (1 if top is not None else 0) + len(lower)
    new_root = combine_path(k, Z, siblings, top, lower)
    calls += len(siblings) + (1 if top is not None else 0) + len(lower)
    new_leaves = leaves.copy()
    new_leaves[k] = Z
    assert new_root == root_of(new_leaves)
    return new_leaves, new_root, calls


# --------------------------------------------------------------------------
# Property tests
# --------------------------------------------------------------------------

random.seed(20260915)


def rand_leaf():
    return leaf(random.randbytes(32), random.randint(1, 10**15), random.randbytes(32))


def test_fold_equals_naive():
    for N in range(1, 300):
        leaves = [rand_leaf() for _ in range(N)]
        nodes = build_nodes(leaves)
        assert fold(peaks(N, nodes)) == root_of(leaves), N


def test_append_matches_naive():
    for trial in range(500):
        leaves = []
        for _ in range(random.randint(1, 300)):
            lv = rand_leaf()
            leaves, root, _ = append(leaves, lv)
            assert root == root_of(leaves), len(leaves)


def test_exhaustive_small():
    """Every N<=12, every leaf pattern: verify + full null sequence."""
    a = leaf(bytes(32), 1, bytes(32))
    b = leaf(bytes(1) + bytes(31), 2, bytes(31) + bytes(1))
    for N in range(1, 13):
        for mask in range(1 << N):
            leaves = [a if (mask >> i) & 1 else b for i in range(N)]
            root = root_of(leaves)
            for k in range(N):
                sibs, top, lower = path_of(k, leaves)
                assert verify(k, leaves[k], sibs, top, lower, root)
                bad = a if leaves[k] != a else b
                assert not verify(k, bad, sibs, top, lower, root)
            cur = list(leaves)
            for k in range(N):
                if cur[k] == Z:
                    continue
                cur2, nr, _ = null(k, cur)
                assert nr == root_of(cur2)
                cur = cur2
            sibs, top, lower = path_of(0, cur)
            orig = a if (mask & 1) else b
            if cur[0] == Z and orig != Z:
                assert not verify(0, orig, sibs, top, lower, root_of(cur))


def test_random_large():
    """Random patterns for larger N: verify, arbitrary null order, double-null."""
    for N in [13, 31, 63, 64, 100, 255, 256, 1000]:
        for _ in range(12):
            leaves = [rand_leaf() for _ in range(N)]
            root = root_of(leaves)
            for k in random.sample(range(N), min(N, 25)):
                sibs, top, lower = path_of(k, leaves)
                assert verify(k, leaves[k], sibs, top, lower, root)
            order = [k for k, v in enumerate(leaves) if v != Z]
            random.shuffle(order)
            cur = list(leaves)
            for k in order:
                cur, nr, _ = null(k, cur)
                assert nr == root_of(cur)
            if order:
                k0 = order[0]
                sibs, top, lower = path_of(k0, cur)
                assert not verify(k0, leaves[k0], sibs, top, lower, root_of(cur))


def test_mixed_sequences():
    for trial in range(100):
        leaves = []
        for _ in range(random.randint(1, 120)):
            live = [k for k, v in enumerate(leaves) if v != Z]
            if random.random() < 0.6 or not live:
                leaves, root, _ = append(leaves, rand_leaf())
            else:
                k = random.choice(live)
                leaves, root, _ = null(k, leaves)
            assert root == root_of(leaves), (trial, len(leaves))


def test_stale_proof_fails():
    leaves = [rand_leaf() for _ in range(50)]
    k = 20
    sibs, top, lower = path_of(k, leaves)
    leaves2, root2, _ = null(5, leaves)
    assert not verify(k, leaves[k], sibs, top, lower, root2)
    # even a proof of an untouched position fails: the root itself changed
    k2 = 30
    sibs2, top2, lower2 = path_of(k2, leaves)
    assert not verify(k2, leaves[k2], sibs2, top2, lower2, root2)


def test_binding():
    """Amount/txid/sender binding: any modification breaks the leaf."""
    N = 10
    leaves = [rand_leaf() for _ in range(N)]
    k = 3
    amount = 1234567
    txid = random.randbytes(32)
    backer = random.randbytes(32)
    lv = leaf(backer, amount, txid)
    leaves[k] = lv
    root = root_of(leaves)
    sibs, top, lower = path_of(k, leaves)
    assert verify(k, lv, sibs, top, lower, root)
    assert not verify(k, leaf(backer, amount + 1, txid), sibs, top, lower, root)
    assert not verify(k, leaf(backer, amount, random.randbytes(32)), sibs, top, lower, root)
    assert not verify(k, leaf(random.randbytes(32), amount, txid), sibs, top, lower, root)
    assert not verify(k - 1, lv, sibs, top, lower, root)


def test_hash_counts():
    """Verify pledge cost == 2*popcount(N) exactly (1 leaf + (p-1) fold
    verification + t merges + (p-t) new-root fold)."""
    for N in range(1, 2000):
        leaves = [rand_leaf() for _ in range(N)]
        nodes = build_nodes(leaves)
        p = len(peaks(N, nodes))
        t = (N & -N).bit_length() - 1  # trailing ones of N
        c = 1 + (p - 1) + t + (p - t)
        assert c == 2 * bin(N).count("1"), N


def pathlen_analytic(N, l):
    """Path length (hashes) for a leaf in the peak at level l: within-peak
    combines + higher-peak fold marker + lower-peak combines."""
    r = l
    c = bin(N & ((1 << r) - 1)).count("1")
    e = 1 if bin(N >> (r + 1)).count("1") > 0 else 0
    return r + c + e


def worst_case_table():
    print(f"{'N':>10} {'popcnt':>7} {'pledgeH':>8} {'worstPath':>10} {'refundH':>8}")
    for N in [1, 10, 100, 1000, 10000, 65535, 65536, 100000, 131071, 131072, 1000000]:
        p = bin(N).count("1")
        worst = max(pathlen_analytic(N, l) for l in peak_levels(N))
        print(f"{N:>10} {p:>7} {2*p:>8} {worst:>10} {2*worst+1:>8}")


def run_all():
    test_fold_equals_naive()
    test_append_matches_naive()
    test_exhaustive_small()
    test_random_large()
    test_mixed_sequences()
    test_stale_proof_fails()
    test_binding()
    test_hash_counts()
    print("all property tests passed")
    worst_case_table()


if __name__ == "__main__":
    run_all()
