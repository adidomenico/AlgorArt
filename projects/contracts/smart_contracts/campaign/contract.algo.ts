import type { Account, bytes, gtxn, uint64 } from '@algorandfoundation/algorand-typescript'
import {
  Box,
  BoxMap,
  Bytes,
  Contract,
  Global,
  GlobalState,
  Txn,
  Uint64,
  abimethod,
  assert,
  itxn,
  op,
} from '@algorandfoundation/algorand-typescript'

/**
 * Campaign — a non-custodial crowdfunding escrow.
 *
 * One stateful application per campaign. Pledged ALGO is held at the app's escrow address and released by the contract itself, based purely
 * on the on-chain state and the transaction group presented by the caller.
 *
 * Backer records live in a fixed-height **fanout-8** padded Merkle tree: each pledge appends a leaf `(address, amount)` and updates the root in
 * O(h) via an MMR frontier, where `h = log8(N)`. A backer proves their leaf with a Merkle proof to `cancelPledge`/`refund`, which marks it
 * spent in a 1-bit-per-leaf bitmap. No per-backer boxes, so the escrow's minimum balance is a small constant and `delete()` is trivial.
 */

// Status is stored in global state as a uint64.
// 0 = Open, 1 = Failed, 2 = Claimed.
const STATUS_OPEN = 0
const STATUS_FAILED = 1
const STATUS_CLAIMED = 2

// A single bytes global-state value is capped at 128 bytes on the AVM.
const MAX_BYTES_PER_STATE_KEY = 128

// A fanout-8 tree: each internal node hashes its 8 children, so height = log8(N). At h = 5 that is 8^5 = 32,768
// backers, and a pledge (append + fold) or refund (proof verify) is ~5 sha256 ops — inside the 700-cost app-call
// budget (a binary tree could not fit; see docs/commitment-redesign.md).
const FANOUT = 8
const TREE_HEIGHT = 5
const FRONTIER_BYTES = 1344 // 32 × (FANOUT − 1) × (TREE_HEIGHT + 1)

// The spent bitmap is sharded into 1024-byte boxes (8192 leaves per shard), each under the 2048-byte box I/O budget.
const BITMAP_SHARD_BITS = 13
const BITMAP_SHARD_BYTES = 1024

// The creator funds the escrow's fixed storage MBR via `fund()` so backers' pledges stay fully refundable: a refund
// only flips a bitmap bit, so the frontier and spent-shard boxes (and their MBR) persist until delete(). The worst
// case is the account base (100,000) + the frontier box (2500 + 400×1345 = 540,500) + the spent shards
// (2500 + 400×1033 = 415,700 each) — the recommended deposit, returned on delete().

// EMPTY[k] = sha256 of an empty fanout-8 subtree of height k, at bytes [k*32, (k+1)*32) of this constant.
const EMPTY = Bytes.fromHex(
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' +
    'da4974409dcfd785cec6321826272da5cf679e2d48a28bab45e77d489752a47b' +
    'e99ccc670b5de422c4e062a6d4c022ab4e130c184efc2cf3267f3f781dd9df77' +
    'e22ee633fd2bb6de05e7e4668b908956c114db86d75ea7514b392466965e0b03' +
    'c7bffaadfee1012c52d1c1506240e8ba7b30528717ec89f99729c4c738a034b4' +
    '4b2f7eba53965fb076d3d078f8d9f7100e0a9258f582b88304350729ad4a78e8',
)
// PREIMAGE[k] = EMPTY[k] repeated 8 times (256 bytes), for k = 0..TREE_HEIGHT-1; the fold pads each level with `replace`.
const PREIMAGE = Bytes.fromHex(
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' +
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' +
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' +
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' +
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' +
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' +
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' +
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' +
    'da4974409dcfd785cec6321826272da5cf679e2d48a28bab45e77d489752a47b' +
    'da4974409dcfd785cec6321826272da5cf679e2d48a28bab45e77d489752a47b' +
    'da4974409dcfd785cec6321826272da5cf679e2d48a28bab45e77d489752a47b' +
    'da4974409dcfd785cec6321826272da5cf679e2d48a28bab45e77d489752a47b' +
    'da4974409dcfd785cec6321826272da5cf679e2d48a28bab45e77d489752a47b' +
    'da4974409dcfd785cec6321826272da5cf679e2d48a28bab45e77d489752a47b' +
    'da4974409dcfd785cec6321826272da5cf679e2d48a28bab45e77d489752a47b' +
    'da4974409dcfd785cec6321826272da5cf679e2d48a28bab45e77d489752a47b' +
    'e99ccc670b5de422c4e062a6d4c022ab4e130c184efc2cf3267f3f781dd9df77' +
    'e99ccc670b5de422c4e062a6d4c022ab4e130c184efc2cf3267f3f781dd9df77' +
    'e99ccc670b5de422c4e062a6d4c022ab4e130c184efc2cf3267f3f781dd9df77' +
    'e99ccc670b5de422c4e062a6d4c022ab4e130c184efc2cf3267f3f781dd9df77' +
    'e99ccc670b5de422c4e062a6d4c022ab4e130c184efc2cf3267f3f781dd9df77' +
    'e99ccc670b5de422c4e062a6d4c022ab4e130c184efc2cf3267f3f781dd9df77' +
    'e99ccc670b5de422c4e062a6d4c022ab4e130c184efc2cf3267f3f781dd9df77' +
    'e99ccc670b5de422c4e062a6d4c022ab4e130c184efc2cf3267f3f781dd9df77' +
    'e22ee633fd2bb6de05e7e4668b908956c114db86d75ea7514b392466965e0b03' +
    'e22ee633fd2bb6de05e7e4668b908956c114db86d75ea7514b392466965e0b03' +
    'e22ee633fd2bb6de05e7e4668b908956c114db86d75ea7514b392466965e0b03' +
    'e22ee633fd2bb6de05e7e4668b908956c114db86d75ea7514b392466965e0b03' +
    'e22ee633fd2bb6de05e7e4668b908956c114db86d75ea7514b392466965e0b03' +
    'e22ee633fd2bb6de05e7e4668b908956c114db86d75ea7514b392466965e0b03' +
    'e22ee633fd2bb6de05e7e4668b908956c114db86d75ea7514b392466965e0b03' +
    'e22ee633fd2bb6de05e7e4668b908956c114db86d75ea7514b392466965e0b03' +
    'c7bffaadfee1012c52d1c1506240e8ba7b30528717ec89f99729c4c738a034b4' +
    'c7bffaadfee1012c52d1c1506240e8ba7b30528717ec89f99729c4c738a034b4' +
    'c7bffaadfee1012c52d1c1506240e8ba7b30528717ec89f99729c4c738a034b4' +
    'c7bffaadfee1012c52d1c1506240e8ba7b30528717ec89f99729c4c738a034b4' +
    'c7bffaadfee1012c52d1c1506240e8ba7b30528717ec89f99729c4c738a034b4' +
    'c7bffaadfee1012c52d1c1506240e8ba7b30528717ec89f99729c4c738a034b4' +
    'c7bffaadfee1012c52d1c1506240e8ba7b30528717ec89f99729c4c738a034b4' +
    'c7bffaadfee1012c52d1c1506240e8ba7b30528717ec89f99729c4c738a034b4',
)

export class Campaign extends Contract {
  /** Address of the creator — the only account allowed to claim. */
  creator = GlobalState<Account>()

  /** Campaign title, e.g. "My first novel". */
  title = GlobalState<bytes>()

  /** URI pointing to off-chain campaign metadata (ARC-3-style JSON blob, e.g. on IPFS). */
  metadataUri = GlobalState<bytes>()

  /** Funding target, in microAlgos. */
  goal = GlobalState<uint64>()

  /** Deadline, as a UNIX timestamp (seconds). */
  deadline = GlobalState<uint64>()

  /** Total amount pledged so far, in microAlgos. */
  raised = GlobalState<uint64>()

  /** Current status: 0 Open, 1 Failed, 2 Claimed. */
  status = GlobalState<uint64>({ initialValue: STATUS_OPEN })

  /** Merkle root over all pledge leaves, updated on every pledge. */
  root = GlobalState<bytes>()

  /** Number of leaves appended so far (the backer count). */
  leafCount = GlobalState<uint64>({ initialValue: 0 })

  /** Storage deposit the creator fronts at create() to cover the escrow's fixed box MBR. */
  deposit = GlobalState<uint64>({ initialValue: 0 })

  /** MMR frontier: the completed-subtree roots, one 32-byte slot per height (empty = 32 zero bytes). */
  frontier = Box<bytes>({ key: 'f' })

  /** Sharded spent bitmap, one bit per leaf index; `spent(index >> 13)` holds 1024 bytes. */
  spent = BoxMap<uint64, bytes>({ keyPrefix: 's' })

  /**
   * Deploy the campaign.
   *
   * @param title Short campaign title (on-chain).
   * @param metadataUri URI of the off-chain campaign metadata (ARC-3-style JSON blob).
   * @param goal Funding target in microAlgos.
   * @param deadline UNIX timestamp (seconds) after which pledging closes.
   */
  @abimethod({ onCreate: 'require' })
  create(title: bytes, metadataUri: bytes, goal: uint64, deadline: uint64): void {
    assert(Txn.applicationId.id === 0, 'must be called on app creation')
    assert(title.length > 0, 'title must not be empty')
    assert(title.length <= MAX_BYTES_PER_STATE_KEY, 'title too long')
    assert(metadataUri.length <= MAX_BYTES_PER_STATE_KEY, 'metadata uri too long')
    assert(goal > 0, 'goal must be greater than zero')
    assert(deadline > Global.latestTimestamp, 'deadline must be in the future')

    this.creator.value = Txn.sender
    this.title.value = title
    this.metadataUri.value = metadataUri
    this.goal.value = goal
    this.deadline.value = deadline
    this.raised.value = 0
    this.status.value = STATUS_OPEN
    this.root.value = this.emptyNode(Uint64(TREE_HEIGHT))
    this.leafCount.value = 0
    this.deposit.value = 0
  }

  /**
   * Fund the campaign's storage deposit.
   *
   * The creator pays ALGO into the escrow to cover the fixed storage MBR (the frontier box and spent shards), so
   * backers' pledges stay fully refundable. The deposit is accumulated and returned to the creator by `delete()`.
   * Without it, the first pledge cannot create the frontier box (insufficient balance).
   *
   * @param payment Payment from the creator to the campaign escrow.
   */
  @abimethod()
  fund(payment: gtxn.PaymentTxn): void {
    assert(Txn.sender === this.creator.value, 'only the creator can fund')
    assert(payment.sender === Txn.sender, 'payment must come from the caller')
    assert(payment.receiver === Global.currentApplicationAddress, 'payment must be made to the campaign escrow')
    assert(payment.amount > 0, 'fund must be greater than zero')
    assert(this.status.value === STATUS_OPEN, 'campaign is not open')

    this.deposit.value = this.deposit.value + payment.amount
  }

  /**
   * Pledge ALGO to the campaign.
   *
   * The caller submits this app call in a group with a payment from their own account to the escrow. The pledge is appended to the Merkle
   * tree as a leaf `(Txn.sender, amount)`.
   *
   * @param payment Payment from the caller to the campaign escrow.
   */
  @abimethod()
  pledge(payment: gtxn.PaymentTxn): void {
    assert(Global.latestTimestamp < this.deadline.value, 'pledging is closed')
    assert(payment.receiver === Global.currentApplicationAddress, 'payment must be made to the campaign escrow')
    assert(payment.sender === Txn.sender, 'payment must come from the caller')
    assert(payment.amount > 0, 'pledge must be greater than zero')
    assert(Txn.sender !== this.creator.value, 'creator cannot pledge to their own campaign')

    this.append(this.leafHash(Txn.sender, payment.amount), this.leafCount.value)
    this.raised.value = this.raised.value + payment.amount
    this.leafCount.value = this.leafCount.value + 1
  }

  /**
   * Release the escrow balance to the creator.
   *
   * Only the creator may call, only once the deadline has passed and only if the goal was reached.
   */
  @abimethod()
  claim(): void {
    assert(Txn.sender === this.creator.value, 'only the creator can claim')
    assert(Global.latestTimestamp >= this.deadline.value, 'deadline has not passed')
    assert(this.raised.value >= this.goal.value, 'goal not reached')
    assert(this.status.value === STATUS_OPEN, 'already claimed')

    this.status.value = STATUS_CLAIMED

    itxn
      .payment({
        receiver: this.creator.value,
        amount: this.escrowBalance(),
      })
      .submit()
  }

  /**
   * Return a backer's pledge.
   *
   * Only after the deadline, when the goal was not reached. The backer proves their leaf against the root; the leaf's bit in the spent
   * bitmap makes a second refund impossible.
   *
   * @param proof The Merkle proof: `height × (fanout − 1)` sibling hashes concatenated, grouped by level.
   * @param index The leaf's slot index.
   * @param amount The pledged amount (bound to the leaf by the proof).
   */
  @abimethod()
  refund(proof: bytes, index: uint64, amount: uint64): void {
    assert(Global.latestTimestamp >= this.deadline.value, 'deadline has not passed')
    assert(this.raised.value < this.goal.value, 'goal was reached, no refunds')

    if (this.status.value === STATUS_OPEN) {
      this.status.value = STATUS_FAILED
    }
    assert(this.status.value === STATUS_FAILED, 'campaign is not refundable')

    this.verifyAndSpend(index, amount, proof)

    itxn
      .payment({
        receiver: Txn.sender,
        amount: amount,
      })
      .submit()
  }

  /**
   * Withdraw a backer's pledge before the deadline.
   *
   * Proves the leaf, marks it spent, decrements `raised` and pays the amount back.
   *
   * @param proof The Merkle proof: `height × (fanout − 1)` sibling hashes concatenated, grouped by level.
   * @param index The leaf's slot index.
   * @param amount The pledged amount (bound to the leaf by the proof).
   */
  @abimethod()
  cancelPledge(proof: bytes, index: uint64, amount: uint64): void {
    assert(Global.latestTimestamp < this.deadline.value, 'pledging is closed')
    assert(this.status.value === STATUS_OPEN, 'campaign is not open')

    this.verifyAndSpend(index, amount, proof)
    this.raised.value = this.raised.value - amount

    itxn
      .payment({
        receiver: Txn.sender,
        amount: amount,
      })
      .submit()
  }

  /**
   * Delete the campaign application and recover the residual ALGO.
   *
   * Creator only, and only once settled with no backer funds remaining: the escrow balance may hold at most the
   * creator's own storage deposit. Deletes the frontier and spent-bitmap boxes, then closes the escrow with
   * `CloseRemainderTo`, returning the residual (the deposit) to the creator and freeing their sponsorship floor.
   */
  @abimethod({ allowActions: 'DeleteApplication' })
  delete(): void {
    assert(Txn.sender === this.creator.value, 'only the creator can delete')
    assert(this.status.value !== STATUS_OPEN, 'cannot delete an open campaign')
    assert(Global.currentApplicationAddress.balance <= this.deposit.value, 'cannot delete with funds remaining')

    this.frontier.delete()

    const shardCount: uint64 = (this.leafCount.value + Uint64(BITMAP_SHARD_BYTES * 8 - 1)) >> Uint64(BITMAP_SHARD_BITS)
    for (let shard = Uint64(0); shard < shardCount; shard = shard + 1) {
      this.spent(shard).delete()
    }

    itxn
      .payment({
        receiver: this.creator.value,
        amount: 0,
        closeRemainderTo: this.creator.value,
      })
      .submit()
  }

  // Append a leaf hash to the tree: update the MMR frontier and the root. `n` is the leaf count before this append.
  private append(leaf: bytes, n: uint64): void {
    let frontier = this.frontier.get({ default: op.bzero(FRONTIER_BYTES) })
    let node: bytes = leaf
    let k = Uint64(0)
    // Merge: while the k-th base-FANOUT digit of `n` is FANOUT-1, the level carries — combine its FANOUT-1 completed
    // subtrees with `node` into one subtree at the next level.
    while (k < Uint64(TREE_HEIGHT)) {
      const digit: uint64 = (n >> (k * Uint64(3))) & Uint64(FANOUT - 1)
      if (digit !== Uint64(FANOUT - 1)) break
      // The FANOUT-1 slots are contiguous: extract them as one range.
      const group = op.extract(frontier, k * Uint64(FANOUT - 1) * Uint64(32), Uint64((FANOUT - 1) * 32))
      node = op.sha256(op.concat(group, node))
      k = k + 1
    }
    // Store the new subtree in the first free slot at the first non-carrying level.
    const slotIndex: uint64 = (n >> (k * Uint64(3))) & Uint64(FANOUT - 1)
    frontier = op.replace(frontier, (k * Uint64(FANOUT - 1) + slotIndex) * Uint64(32), node)
    this.frontier.value = frontier
    this.root.value = this.fold(frontier, n + 1)
  }

  // Compute the empty-padded fold of the frontier for `count` leaves (the root).
  private fold(frontier: bytes, count: uint64): bytes {
    // A fully-loaded tree collapses into a single subtree at level TREE_HEIGHT.
    if (count === Uint64(32768)) {
      return op.extract(frontier, Uint64(TREE_HEIGHT * (FANOUT - 1)) * Uint64(32), 32)
    }
    let partial: bytes = op.bzero(0)
    let hasPartial = false
    let k = Uint64(0)
    while (k < Uint64(TREE_HEIGHT)) {
      const occupied: uint64 = (count >> (k * Uint64(3))) & Uint64(FANOUT - 1)
      // Start from EMPTY[k] × FANOUT, then overwrite the occupied slots and the partial with `replace`.
      let buffer: bytes = this.emptyGroup(k)
      if (occupied > 0) {
        const group = op.extract(frontier, k * Uint64(FANOUT - 1) * Uint64(32), occupied * Uint64(32))
        buffer = op.replace(buffer, 0, group)
      }
      if (hasPartial) {
        buffer = op.replace(buffer, occupied * Uint64(32), partial)
      }
      partial = op.sha256(buffer)
      hasPartial = true
      k = k + 1
    }
    return partial
  }

  // Verify the caller's proof and mark the leaf spent, atomically.
  private verifyAndSpend(index: uint64, amount: uint64, proof: bytes): void {
    let node: bytes = op.sha256(op.concat(Txn.sender.bytes, op.itob(amount)))
    let siblingOffset = Uint64(0)
    let k = Uint64(0)
    while (k < Uint64(TREE_HEIGHT)) {
      const digit: uint64 = (index >> (k * Uint64(3))) & Uint64(FANOUT - 1)
      // children = siblings[0..digit-1] ++ node ++ siblings[digit..FANOUT-2]
      const left = op.extract(proof, siblingOffset, digit * Uint64(32))
      const right = op.extract(proof, siblingOffset + digit * Uint64(32), (Uint64(FANOUT - 1) - digit) * Uint64(32))
      node = op.sha256(op.concat(op.concat(left, node), right))
      siblingOffset = siblingOffset + Uint64(FANOUT - 1) * Uint64(32)
      k = k + 1
    }
    assert(node.equals(this.root.value), 'invalid proof')

    const shardIndex: uint64 = index >> Uint64(BITMAP_SHARD_BITS)
    const bitIndex: uint64 = index & Uint64(BITMAP_SHARD_BYTES * 8 - 1)
    const shard = this.spent(shardIndex).get({ default: op.bzero(BITMAP_SHARD_BYTES) })
    assert(!op.getBit(shard, bitIndex), 'already spent')
    this.spent(shardIndex).value = op.setBit(shard, bitIndex, 1)
  }

  // The hash of a pledge leaf: sha256(address(32) || amount(8)).
  private leafHash(account: Account, amount: uint64): bytes {
    return op.sha256(op.concat(account.bytes, op.itob(amount)))
  }

  // The root of an empty subtree of height k (a precomputed constant).
  private emptyNode(k: uint64): bytes {
    return op.extract(EMPTY, k * 32, 32)
  }

  // The preimage of an empty level-k subtree: EMPTY[k] repeated FANOUT times (256 bytes), for the fold's padding.
  private emptyGroup(k: uint64): bytes {
    return op.extract(PREIMAGE, k * 256, 256)
  }

  /** The spendable ALGO held at the escrow address (total minus the minimum balance). */
  private escrowBalance(): uint64 {
    const balance = Global.currentApplicationAddress.balance
    return balance - Global.currentApplicationAddress.minBalance
  }
}
