import type { Account, Application, bytes, gtxn, uint64 } from '@algorandfoundation/algorand-typescript'
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
 * Campaign - a non-custodial crowdfunding campaign with a frontier-Merkle receipt tree (see
 * docs/claim-tree-protocol.md for the full design and security analysis).
 *
 * One stateful application per campaign. Backers' pledged ALGO goes to the **ClaimsVault** (the pooled refund
 * escrow); the campaign app itself holds no funds at all - not even a creator deposit - so creation costs the creator
 * only the global-schema sponsorship floor on their own account (~0.24 ALGO, recovered at `delete()`).
 *
 * A backer's receipt is their pledge leaf in the campaign's incremental tree: `leaf = H(0x01 ‖ backer ‖ amount ‖
 * paymentTxId)`, committed at pledge time from the in-group payment (never caller-supplied). The contract stores only
 * the single 32-byte root plus the position count N; callers supply frontiers/paths that the contract authenticates
 * against the stored root. Cancellations and refunds null the leaf in place, and the vault pays out on the campaign's
 * inner instruction - the tree itself is the anti-double-refund state, with no ASA, no boxes, and no per-backer
 * storage on the campaign.
 *
 * Because no backer funds ever sit in the campaign escrow, the creator can finalize (and delete) the campaign in O(1)
 * on **both** paths - after a successful claim, or after a failure, even when backers never act - while the vault
 * keeps paying failed-campaign refunds after the campaign is gone.
 */

// Status is stored in global state as a uint64.
// 0 = Open, 1 = Failed, 2 = Claimed.
const STATUS_OPEN = 0
const STATUS_FAILED = 1
const STATUS_CLAIMED = 2

// A single bytes global-state value is capped at 128 bytes on the AVM.
const MAX_BYTES_PER_STATE_KEY = 128

// `H(0x01)` domain prefix for leaves: no 64-byte internal-node preimage can collide with the 73-byte leaf preimage.
const LEAF_DOMAIN = Bytes.fromHex('01')

// `Z`, the consumed-leaf marker and the empty-tree root: 32 zero bytes.
const ZERO_ROOT = Bytes.fromHex('0000000000000000000000000000000000000000000000000000000000000000')

// ARC-4 method selectors for the ClaimsVault methods this contract invokes as inner app calls (computed from the
// emitted ARC-56 signatures - see smart_contracts/claimsvault/contract.algo.ts; kept in sync by the integration tests).
const VAULT_PAY_BACK_SELECTOR = Bytes.fromHex('b0e0eedf') // payBack(uint64,address,uint64)void
const VAULT_PAY_CLAIM_SELECTOR = Bytes.fromHex('f8c4e0cb') // payClaim(uint64)void
const VAULT_SETTLE_SELECTOR = Bytes.fromHex('09200848') // settle(uint64,byte[],uint64)void
const VAULT_NOTIFY_DELETE_SELECTOR = Bytes.fromHex('87060e1d') // notifyDelete(uint64)void

export class Campaign extends Contract {
  /** Address of the creator - the only account allowed to claim and delete. */
  creator = GlobalState<Account>()

  /** The ClaimsVault app - the pooled refund escrow that holds pledges and pays refunds/claims. */
  vault = GlobalState<Application>()

  /** Campaign title, e.g. "My first novel". */
  title = GlobalState<bytes>()

  /** URI pointing to off-chain campaign metadata (ARC-3-style JSON blob, e.g. on IPFS). */
  metadataUri = GlobalState<bytes>()

  /** Funding target, in microAlgos. */
  goal = GlobalState<uint64>()

  /** Deadline, as a UNIX timestamp (seconds). */
  deadline = GlobalState<uint64>()

  /** Live pledge total, in microAlgos (pledges minus cancellations/refunds). */
  raised = GlobalState<uint64>({ initialValue: 0 })

  /** Current status: 0 Open, 1 Failed, 2 Claimed. */
  status = GlobalState<uint64>({ initialValue: STATUS_OPEN })

  /** The single stored tree root: fold of the frontier peaks, or Z while N == 0. */
  root = GlobalState<bytes>()

  /** N: number of positions ever appended; never decremented. */
  n = GlobalState<uint64>({ initialValue: 0 })

  /**
   * Deploy the campaign.
   *
   * Unlike the Claim ASA design there is nothing to fund: the escrow never holds funds (pledges go to the vault, and
   * the tree lives in global state sponsored by the creator's account).
   *
   * @param vault The ClaimsVault app that holds the backers' pledges.
   * @param title Short campaign title (on-chain).
   * @param metadataUri URI of the off-chain campaign metadata (ARC-3-style JSON blob).
   * @param goal Funding target in microAlgos.
   * @param deadline UNIX timestamp (seconds) after which pledging closes.
   */
  @abimethod({ onCreate: 'require' })
  create(vault: Application, title: bytes, metadataUri: bytes, goal: uint64, deadline: uint64): void {
    assert(Txn.applicationId.id === 0, 'must be called on app creation')
    assert(title.length > 0, 'title must not be empty')
    assert(title.length <= MAX_BYTES_PER_STATE_KEY, 'title too long')
    assert(metadataUri.length <= MAX_BYTES_PER_STATE_KEY, 'metadata uri too long')
    assert(goal > 0, 'goal must be greater than zero')
    assert(deadline > Global.latestTimestamp, 'deadline must be in the future')

    this.creator.value = Txn.sender
    this.vault.value = vault
    this.title.value = title
    this.metadataUri.value = metadataUri
    this.goal.value = goal
    this.deadline.value = deadline
    this.raised.value = 0
    this.status.value = STATUS_OPEN
    this.root.value = ZERO_ROOT
    this.n.value = 0
  }

  /**
   * Append one pledge leaf.
   *
   * The caller submits this app call in a group with a payment from their own account **to the vault** (the pooled
   * refund escrow), followed by the vault's `credit` call in the same group (which records the inflow). The caller
   * supplies the frontier (peaks ascending, 32 bytes each); the contract authenticates it with `fold` against the
   * stored root, derives the leaf from the in-group payment (`sender ‖ amount ‖ txnId` - never caller-supplied), runs
   * the merge cascade, and stores the new root. N == 0 takes the empty-frontier branch.
   *
   * @param payment Payment from the caller to the vault.
   * @param frontier The current frontier peaks, ascending level order.
   */
  @abimethod()
  pledge(payment: gtxn.PaymentTxn, frontier: bytes): void {
    assert(Global.latestTimestamp < this.deadline.value, 'pledging is closed')
    assert(this.status.value === STATUS_OPEN, 'campaign is not open')
    assert(payment.receiver === this.vault.value.address, 'payment must be made to the vault')
    assert(payment.sender === Txn.sender, 'payment must come from the caller')
    assert(payment.amount > Uint64(0), 'pledge must be greater than zero')
    assert(Txn.sender !== this.creator.value, 'creator cannot pledge to their own campaign')

    const n = this.n.value
    const p = this.popcount(n)
    assert(frontier.length === p * Uint64(32), 'bad frontier length')
    ensureBudget(p * Uint64(70) + Uint64(400), OpUpFeeSource.GroupCredit)

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
   * Withdraw a backer's pledge before the deadline.
   *
   * The caller proves their leaf (rebuilt from caller + proof, never trusted) against the stored root; the contract
   * nulls it, decrements `raised`, and instructs the vault to pay the caller back. A second cancellation of the same
   * position - or a proof built against any older root - reconstructs a non-stored root and is rejected.
   *
   * @param k Leaf position to null.
   * @param amount Pledged amount committed by the leaf.
   * @param txid The pledge payment's transaction ID, committed in the leaf at pledge time.
   * @param path The auth path as one blob: siblings (32·r) ‖ top (32·e) ‖ lower (32·c).
   */
  @abimethod()
  cancelPledge(k: uint64, amount: uint64, txid: bytes, path: bytes): void {
    assert(Global.latestTimestamp < this.deadline.value, 'pledging is closed')
    assert(this.status.value === STATUS_OPEN, 'campaign is not open')

    this.spendLeaf(k, amount, txid, path)
  }

  /**
   * Return a backer's pledge after a failed campaign.
   *
   * Only after the deadline, when the goal was not reached. Same proof mechanics as `cancelPledge`; the first refund
   * flips an Open campaign to Failed. Keeps working as long as the campaign app exists, with no creator involvement -
   * and after `settleOpen`/deletion, backers use the vault's `refund` directly with the same proofs.
   *
   * @param k Leaf position to null.
   * @param amount Pledged amount committed by the leaf.
   * @param txid The pledge payment's transaction ID, committed in the leaf at pledge time.
   * @param path The auth path as one blob: siblings (32·r) ‖ top (32·e) ‖ lower (32·c).
   */
  @abimethod()
  refund(k: uint64, amount: uint64, txid: bytes, path: bytes): void {
    assert(Global.latestTimestamp >= this.deadline.value, 'deadline has not passed')
    assert(this.raised.value < this.goal.value, 'goal was reached, no refunds')

    if (this.status.value === STATUS_OPEN) {
      this.status.value = STATUS_FAILED
    }
    assert(this.status.value === STATUS_FAILED, 'campaign is not refundable')

    this.spendLeaf(k, amount, txid, path)
  }

  /**
   * Release the campaign funds to the creator.
   *
   * Only the creator may call, only once the deadline has passed and only if the goal was reached. The campaign sets
   * its status to Claimed and asks the vault (via an inner app call) to pay the creator - the vault derives the payout
   * (`paidIn − paidOut`, exactly the live pledge total). No backer action is needed after success.
   */
  @abimethod()
  claim(): void {
    assert(Txn.sender === this.creator.value, 'only the creator can claim')
    assert(Global.latestTimestamp >= this.deadline.value, 'deadline has not passed')
    assert(this.raised.value >= this.goal.value, 'goal not reached')
    assert(this.status.value === STATUS_OPEN, 'already claimed')

    this.status.value = STATUS_CLAIMED

    itxn
      .applicationCall({
        appId: this.vault.value,
        appArgs: [VAULT_PAY_CLAIM_SELECTOR, op.itob(Global.currentApplicationId.id)],
        fee: Uint64(0),
      })
      .submit()
  }

  /**
   * Delete the campaign application and close the escrow to the creator.
   *
   * Creator only. The escrow never holds backer funds, so deletion is O(1) on **every** path, even when backers never
   * act:
   *
   * - **Claimed** - the vault releases the campaign's box (`notifyDelete`: requires Claimed with inflows fully paid
   *   out), recovering its minimum balance to the pool.
   * - **Failed** (or failed in fact: Open with the deadline passed and the goal not reached) - the vault records the
   *   failed settlement with the final root/N (`settle`), after which backers keep refunding **directly from the
   *   vault** until the window closes; `finalize` later recovers the box.
   * - **Pristine** (Open with `raised == 0`) - `settle` runs unconditionally and no-ops when no box exists; if a
   *   stray no-pledge inflow created one, it settles to Failed so `finalize` can recover it instead of stranding it.
   * - **Open with N > 0 but `raised == 0`** (everything cancelled) - settled like a failure; nothing is owed.
   */
  @abimethod({ allowActions: 'DeleteApplication' })
  delete(): void {
    assert(Txn.sender === this.creator.value, 'only the creator can delete')

    const failedInFact =
      this.status.value === STATUS_OPEN && Global.latestTimestamp >= this.deadline.value && this.raised.value < this.goal.value
    assert(
      this.status.value !== STATUS_OPEN || this.raised.value === Uint64(0) || failedInFact,
      'cannot delete a campaign with live pledges',
    )

    if (failedInFact) {
      this.status.value = STATUS_FAILED
    }

    if (this.status.value === STATUS_CLAIMED) {
      itxn
        .applicationCall({
          appId: this.vault.value,
          appArgs: [VAULT_NOTIFY_DELETE_SELECTOR, op.itob(Global.currentApplicationId.id)],
          fee: Uint64(0),
        })
        .submit()
    } else {
      // Always settle (a no-op when no box exists): this also settles stray no-pledge inflows a pristine campaign
      // cannot see, so they become finalizable instead of stranded.
      itxn
        .applicationCall({
          appId: this.vault.value,
          appArgs: [
            VAULT_SETTLE_SELECTOR,
            op.itob(Global.currentApplicationId.id),
            this.prefixedBytes(this.root.value),
            op.itob(this.n.value),
          ],
          fee: Uint64(0),
        })
        .submit()
    }

    itxn
      .payment({
        receiver: this.creator.value,
        amount: Uint64(0),
        closeRemainderTo: this.creator.value,
        fee: Uint64(0),
      })
      .submit()
  }

  /**
   * Verify a caller's leaf proof against the stored root, null the leaf, decrement `raised`, and pay the caller back
   * via the vault. Shared by `cancelPledge` and `refund` (their guards differ; the spend mechanics are identical).
   *
   * A second spend of the same position - or a proof built against any older root - reconstructs a non-stored root
   * and is rejected, so no leaf can ever pay twice.
   *
   * @param k Leaf position to null.
   * @param amount Pledged amount committed by the leaf.
   * @param txid The pledge payment's transaction ID, committed in the leaf at pledge time.
   * @param path The auth path as one blob: siblings (32·r) ‖ top (32·e) ‖ lower (32·c).
   */
  private spendLeaf(k: uint64, amount: uint64, txid: bytes, path: bytes): void {
    assert(amount > Uint64(0), 'amount must be greater than zero')
    assert(txid.length === Uint64(32), 'bad txid length')
    const n = this.n.value
    assert(k < n, 'unknown position')

    // Derive the expected path shape from (n, k), then size the opcode budget from it (spec §14): the caller funds the
    // OpUp headroom, and an underfunded call fails atomically.
    const r = this.pathLen(n, k)
    const c = this.popcount(n - op.shl(op.shr(n, r), r))
    const hasTop = op.shr(n, r + Uint64(1)) > Uint64(0)
    let h: uint64 = r + c
    if (hasTop) {
      h = h + Uint64(1)
    }
    assert(path.length === h * Uint64(32), 'bad path length')
    ensureBudget(h * Uint64(70) + Uint64(700), OpUpFeeSource.GroupCredit)

    const leaf = op.sha512_256(LEAF_DOMAIN.concat(Txn.sender.bytes).concat(op.itob(amount)).concat(txid))
    assert(this.combineBlob(leaf, k, path, r, c, hasTop) === this.root.value, 'proof does not match root')

    this.root.value = this.combineBlob(ZERO_ROOT, k, path, r, c, hasTop)
    this.raised.value = this.raised.value - amount

    itxn
      .applicationCall({
        appId: this.vault.value,
        appArgs: [VAULT_PAY_BACK_SELECTOR, op.itob(Global.currentApplicationId.id), Txn.sender.bytes, op.itob(amount)],
        fee: Uint64(0),
      })
      .submit()
  }

  /**
   * ARC-4-encode a byte string for raw inner app args: uint16 big-endian length prefix + bytes. (Static types like
   * `address` need no prefix; dynamic `byte[]` does - the callee's ABI router strips it.)
   *
   * @param value The bytes to encode.
   * @returns The length-prefixed encoding.
   */
  private prefixedBytes(value: bytes): bytes {
    return op.itob(value.length).slice(6, 8).concat(value)
  }

  /**
   * Hash two child nodes into their parent (SHA-512/256 - the AVM `sha512_256` opcode, *not* `sha256`).
   *
   * @param left Left child.
   * @param right Right child.
   * @returns The parent node.
   */
  private hashPair(left: bytes, right: bytes): bytes {
    return op.sha512_256(left.concat(right))
  }

  /**
   * Test the lowest bit (the PuyaTs arithmetic operators cover `+ - *` and comparisons only - shifts and bitwise
   * operators fall back to JS `number` semantics, so this helper uses `op.shr`/`op.shl` instead of `& 1`).
   *
   * @param n The value to test.
   * @returns True when `n` is odd.
   */
  private isOdd(n: uint64): boolean {
    return n !== op.shl(op.shr(n, Uint64(1)), Uint64(1))
  }

  /**
   * Count the set bits of N (= the frontier peak count). Exits at the highest set bit, so the cost is O(log N).
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
    /* v8 ignore next - reachable only for N = 2^64 − 1 (no early exit in 64 iterations); defensive cap. */
    return count
  }

  /**
   * Count the trailing ones of N (= the merge cascade length).
   *
   * @param n The value to count.
   * @returns The trailing-ones count.
   */
  private trailingOnes(n: uint64): uint64 {
    let t: uint64 = Uint64(0)
    for (const i of urange(Uint64(64))) {
      if (this.isOdd(op.shr(n, i))) {
        t = t + Uint64(1)
      } else {
        return t
      }
    }
    /* v8 ignore next - reachable only for N = 2^64 − 1 (all bits set); defensive cap. */
    return t
  }

  /**
   * Within-peak path length for position k at size N: the first level whose sibling block extends past N.
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
    /* v8 ignore next - reachable only for trees of depth 64 (no missing level); defensive cap. */
    return r
  }

  /**
   * Fold ascending peaks into the single stored root: acc = highest; acc = H(acc ‖ peak) descending.
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
   * Recombine a leaf value along its path into the root: within-peak siblings by direction bit, then
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

  /**
   * Recombine along a single-blob path (`siblings ‖ top ‖ lower`), split at the derived cut points.
   *
   * @param start The leaf value (genuine leaf to verify, Z to null).
   * @param k Leaf position.
   * @param path The auth path blob.
   * @param r Within-peak path length.
   * @param c Lower-peak count.
   * @param hasTop Whether a higher-peak fold is present.
   * @returns The recombined root.
   */
  private combineBlob(start: bytes, k: uint64, path: bytes, r: uint64, c: uint64, hasTop: boolean): bytes {
    const cut1: uint64 = r * Uint64(32)
    let topLen: uint64 = Uint64(0)
    if (hasTop) {
      topLen = Uint64(32)
    }
    return this.combinePath(start, k, path.slice(Uint64(0), cut1), path.slice(cut1, cut1 + topLen), path.slice(cut1 + topLen), r, c, hasTop)
  }
}
