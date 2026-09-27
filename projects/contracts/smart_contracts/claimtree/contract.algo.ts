import type { Account, bytes, gtxn, uint64 } from '@algorandfoundation/algorand-typescript'
import {
  Bytes,
  Contract,
  Global,
  GlobalState,
  OpUpFeeSource,
  Txn,
  Uint64,
  abimethod,
  assert,
  ensureBudget,
  itxn,
  op,
  urange,
} from '@algorandfoundation/algorand-typescript'

/**
 * ClaimTree spike — the smallest on-chain slice of `docs/claim-tree-protocol.md` that proves the tree math differentially:
 * `create` + `pledge` (frontier-authenticated append, spec §4) + `refund` (path-verified in-place null, spec §5).
 *
 * The differential test (`contract.integration.test.ts`) drives every step from the Python reference oracle
 * (`spike_oracle.py`, backed by `docs/claim-tree-protocol-reference.py`) using the REAL on-chain payment TxIDs, and asserts
 * `root == oracle_root`, `n == oracle_n`, `raised == oracle_raised` after every operation — plus rejections for double
 * refunds and stale proofs.
 *
 * Deliberate spike simplifications (NOT the spec — see §9 for the full design):
 *
 * - Single app, no vault split: pledges pay the campaign escrow and refunds pay out of it. Fund plumbing is proven by the
 *   existing Claim ASA suite; the spike isolates the Merkle math.
 * - No `credit` call: with no vault there is no pooled account to attribute, so `paidInOf`/`paidOutOf` collapse to the escrow
 *   balance itself.
 * - No status machine / factory / claim / delete / windows: `refund` only needs deadline-passed + `raised < goal`.
 * - The refund path is `(siblings, top, lower)` as three `byte[]` args instead of one framed blob — framing is not under test.
 * - The `leaf != Z` append assert is omitted: it would require a SHA-512/256 preimage of zero, which is cryptographically vacuous.
 */

// `H(0x01)` domain prefix for leaves (spec §2): no 64-byte internal-node preimage can collide with the 73-byte leaf preimage.
const LEAF_DOMAIN = Bytes.fromHex('01')

// `Z`, the consumed-leaf marker (spec §2): 32 zero bytes.
const ZERO_ROOT = Bytes.fromHex('0000000000000000000000000000000000000000000000000000000000000000')

// Forced OpUp budget for `refund` (spec §14, Amendment A1): the natural cost here fits in one call budget, so sizing 2,800
// PROVES the `ensureBudget` mechanism fires on LocalNet — if OpUp app-creates did not add budget, this method could not run.
const REFUND_BUDGET = Uint64(2800)

export class ClaimTree extends Contract {
  /** Campaign creator (kept for the deadline/goal guards; creator self-pledge is out of scope for the spike). */
  creator = GlobalState<Account>()

  /** Funding target, in microAlgos. */
  goal = GlobalState<uint64>()

  /** Deadline, as a UNIX timestamp (seconds). */
  deadline = GlobalState<uint64>()

  /** Live pledge total, in microAlgos. */
  raised = GlobalState<uint64>({ initialValue: 0 })

  /** N: number of positions ever appended; never decremented (spec §3). */
  n = GlobalState<uint64>({ initialValue: 0 })

  /** The single stored root: fold of the frontier peaks, or Z while N == 0 (spec §3). */
  root = GlobalState<bytes>()

  /**
   * Deploy the spike campaign.
   *
   * @param goal Funding target in microAlgos.
   * @param deadline UNIX timestamp (seconds) after which pledging closes and refunds open.
   */
  @abimethod({ onCreate: 'require' })
  create(goal: uint64, deadline: uint64): void {
    assert(Txn.applicationId.id === 0, 'must be called on app creation')
    assert(goal > 0, 'goal must be greater than zero')
    assert(deadline > Global.latestTimestamp, 'deadline must be in the future')

    this.creator.value = Txn.sender
    this.goal.value = goal
    this.deadline.value = deadline
    this.raised.value = 0
    this.n.value = 0
    this.root.value = ZERO_ROOT
  }

  /**
   * Append one pledge leaf (spec §4).
   *
   * The caller supplies the frontier (peaks ascending, 32 bytes each); the contract authenticates it with `fold` against the
   * stored root, derives the leaf from the in-group payment (`sender ‖ amount ‖ txnId` — never caller-supplied), runs the merge
   * cascade, and stores the new root. N == 0 takes the empty-frontier branch.
   *
   * @param payment Payment from the caller to the campaign escrow.
   * @param frontier The current frontier peaks, ascending level order.
   */
  @abimethod()
  pledge(payment: gtxn.PaymentTxn, frontier: bytes): void {
    assert(Global.latestTimestamp < this.deadline.value, 'pledging is closed')
    assert(payment.receiver === Global.currentApplicationAddress, 'payment must be made to the campaign escrow')
    assert(payment.sender === Txn.sender, 'payment must come from the caller')
    assert(payment.amount > Uint64(0), 'pledge must be greater than zero')

    const n = this.n.value
    assert(frontier.length === this.popcount(n) * Uint64(32), 'bad frontier length')

    const leaf = op.sha512_256(LEAF_DOMAIN.concat(Txn.sender.bytes).concat(op.itob(payment.amount)).concat(payment.txnId))

    let newRoot: bytes = leaf
    if (n > Uint64(0)) {
      assert(this.foldPeaks(frontier) === this.root.value, 'stale or forged frontier')
      const t = this.trailingOnes(n)
      let g: bytes = leaf
      for (const i of urange(t)) {
        g = this.hashPair(frontier.slice(i * Uint64(32), (i + Uint64(1)) * Uint64(32)), g)
      }
      newRoot = this.foldPeaks(g.concat(frontier.slice(t * Uint64(32))))
    }

    this.root.value = newRoot
    this.n.value = n + Uint64(1)
    this.raised.value = this.raised.value + payment.amount
  }

  /**
   * Null one pledge leaf and pay it back (spec §5).
   *
   * Recomputes the leaf from the caller + proof (never trusted), verifies the path against the stored root, recomputes with Z,
   * stores the null root, and pays `amount` to the caller. A second refund of the same position — or a proof built against any
   * older root — reconstructs a non-stored root and is rejected.
   *
   * @param k Leaf position to null.
   * @param amount Pledged amount committed by the leaf.
   * @param txid The pledge payment's transaction ID, committed in the leaf at pledge time.
   * @param siblings The within-peak sibling hashes, ascending level.
   * @param top The fold of all peaks above the leaf's peak (empty when none).
   * @param lower The peaks below the leaf's peak, ascending level.
   */
  @abimethod()
  refund(k: uint64, amount: uint64, txid: bytes, siblings: bytes, top: bytes, lower: bytes): void {
    assert(Global.latestTimestamp >= this.deadline.value, 'deadline has not passed')
    assert(this.raised.value < this.goal.value, 'goal was reached, no refunds')
    const n = this.n.value
    assert(k < n, 'unknown position')
    assert(txid.length === Uint64(32), 'bad txid length')

    ensureBudget(REFUND_BUDGET, OpUpFeeSource.GroupCredit)

    // Derive the expected path shape from (n, k): r = first level whose sibling block extends past N (spec §5).
    const r = this.pathLen(n, k)
    const c = this.popcount(n - op.shl(op.shr(n, r), r))
    const hasTop = op.shr(n, r + Uint64(1)) > Uint64(0)
    assert(siblings.length === r * Uint64(32), 'bad siblings length')
    assert(lower.length === c * Uint64(32), 'bad lower length')
    if (hasTop) {
      assert(top.length === Uint64(32), 'bad top length')
    } else {
      assert(top.length === Uint64(0), 'bad top length')
    }

    const leaf = op.sha512_256(LEAF_DOMAIN.concat(Txn.sender.bytes).concat(op.itob(amount)).concat(txid))
    assert(this.combinePath(leaf, k, siblings, top, lower, r, c, hasTop) === this.root.value, 'proof does not match root')
    this.root.value = this.combinePath(ZERO_ROOT, k, siblings, top, lower, r, c, hasTop)
    this.raised.value = this.raised.value - amount

    itxn
      .payment({
        receiver: Txn.sender,
        amount: amount,
        fee: Uint64(0),
      })
      .submit()
  }

  /**
   * Hash two child nodes into their parent.
   *
   * @param left Left child (older peak / accumulator on the left per the fold convention).
   * @param right Right child.
   * @returns The parent node.
   */
  private hashPair(left: bytes, right: bytes): bytes {
    return op.sha512_256(left.concat(right))
  }

  /**
   * Test the lowest bit (the PuyaTs arithmetic operators cover `+ - *` and comparisons only — shifts and bitwise
   * operators fall back to JS `number` semantics, so this helper uses `op.shr`/`op.shl` instead of `& 1`).
   *
   * @param n The value to test.
   * @returns True when `n` is odd.
   */
  private isOdd(n: uint64): boolean {
    return n !== op.shl(op.shr(n, Uint64(1)), Uint64(1))
  }

  /**
   * Count the set bits of N (= the frontier peak count, spec §3). Exits at the highest set bit, so the cost is
   * O(log N), not O(64) — a full 64-iteration scan would not fit one opcode budget on its own.
   *
   * @param n The value to count.
   * @returns The popcount.
   */
  private popcount(n: uint64): uint64 {
    let count: uint64 = Uint64(0)
    for (const i of urange(Uint64(64))) {
      const rest: uint64 = op.shr(n, i)
      if (rest === Uint64(0)) {
        return count
      }
      if (this.isOdd(rest)) {
        count = count + Uint64(1)
      }
    }
    return count
  }

  /**
   * Count the trailing ones of N (= the merge cascade length, spec §4).
   *
   * @param n The value to count.
   * @returns The trailing-ones count.
   */
  private trailingOnes(n: uint64): uint64 {
    let t = Uint64(0)
    for (const i of urange(Uint64(64))) {
      if (this.isOdd(op.shr(n, i))) {
        t = t + Uint64(1)
      } else {
        return t
      }
    }
    return t
  }

  /**
   * Within-peak path length for position k at size N: the first level whose sibling block extends past N (spec §5).
   * Returns at the first missing level, so the cost is O(r), not O(64).
   *
   * @param n Tree size (positions ever appended).
   * @param k Leaf position.
   * @returns The within-peak path length r.
   */
  private pathLen(n: uint64, k: uint64): uint64 {
    let r: uint64 = Uint64(0)
    for (const l of urange(Uint64(64))) {
      const i = op.shr(k, l)
      let sib: uint64 = i + Uint64(1)
      if (this.isOdd(i)) {
        sib = i - Uint64(1)
      }
      if (op.shl(sib + Uint64(1), l) <= n) {
        r = r + Uint64(1)
      } else {
        return r
      }
    }
    return r
  }

  /**
   * Fold ascending peaks into the single stored root (spec §3): acc = highest; acc = H(acc ‖ peak) descending.
   *
   * @param peaks Concatenated peak values, ascending level order.
   * @returns The fold root.
   */
  private foldPeaks(peaks: bytes): bytes {
    const count = op.shr(peaks.length, Uint64(5))
    assert(count > Uint64(0), 'no peaks')
    assert(peaks.length === op.shl(count, Uint64(5)), 'bad peaks length')
    let acc: bytes = peaks.slice((count - Uint64(1)) * Uint64(32), count * Uint64(32))
    for (const j of urange(count - Uint64(1))) {
      const idx: uint64 = count - Uint64(2) - j
      acc = this.hashPair(acc, peaks.slice(idx * Uint64(32), (idx + Uint64(1)) * Uint64(32)))
    }
    return acc
  }

  /**
   * Recombine a leaf value along its path into the root (spec §5): within-peak siblings by direction bit, then
   * H(top ‖ acc), then lower peaks descending.
   *
   * @param start The leaf value (genuine leaf to verify, Z to null).
   * @param k Leaf position.
   * @param siblings Within-peak sibling hashes, ascending level.
   * @param top Fold of higher peaks (empty when none).
   * @param lower Lower peaks, ascending level.
   * @param r Within-peak path length.
   * @param c Lower-peak count.
   * @param hasTop Whether a higher-peak fold is present.
   * @returns The recombined root.
   */
  private combinePath(start: bytes, k: uint64, siblings: bytes, top: bytes, lower: bytes, r: uint64, c: uint64, hasTop: boolean): bytes {
    let acc: bytes = start
    for (const l of urange(r)) {
      const sib = siblings.slice(l * Uint64(32), (l + Uint64(1)) * Uint64(32))
      if (!this.isOdd(op.shr(k, l))) {
        acc = this.hashPair(acc, sib)
      } else {
        acc = this.hashPair(sib, acc)
      }
    }
    if (hasTop) {
      acc = this.hashPair(top, acc)
    }
    for (const j of urange(c)) {
      const idx: uint64 = c - Uint64(1) - j
      acc = this.hashPair(acc, lower.slice(idx * Uint64(32), (idx + Uint64(1)) * Uint64(32)))
    }
    return acc
  }
}
