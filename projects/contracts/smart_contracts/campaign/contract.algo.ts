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
 * Backer records live in a fixed-height (h = 15) padded Merkle tree: each pledge appends a leaf `(address, amount)` and updates the root in
 * O(h) via an MMR frontier. A backer proves their leaf with a Merkle proof to `cancelPledge`/`refund`, which marks it spent in a
 * 1-bit-per-leaf bitmap. No per-backer boxes, so the escrow's minimum balance is a small constant and `delete()` is trivial.
 */

// Status is stored in global state as a uint64.
// 0 = Open, 1 = Failed, 2 = Claimed.
const STATUS_OPEN = 0
const STATUS_FAILED = 1
const STATUS_CLAIMED = 2

// A single bytes global-state value is capped at 128 bytes on the AVM.
const MAX_BYTES_PER_STATE_KEY = 128

// Fixed tree height: 2^15 = 32,768 backers. A pledge (append + fold) and a refund (proof verify) are each h + 1 sha256 ops; at h = 15 that
// is 16 × 35 = 560 opcode cost, inside the 700-cost app-call budget (sha256 costs 35, sha512_256 costs 45).
const TREE_HEIGHT = 15
const FRONTIER_BYTES = 512 // 32 bytes per peak height

// The spent bitmap is sharded into 1024-byte boxes (8192 leaves per shard), each under the 2048-byte box I/O budget.
const BITMAP_SHARD_BITS = 13
const BITMAP_SHARD_BYTES = 1024

// The creator pre-funds the escrow's fixed storage MBR so backers' pledges stay fully refundable: a refund only flips
// a bitmap bit, so the frontier and spent-shard boxes (and their MBR) persist until delete(). The worst case is the
// account base (100,000) + the frontier box (2500 + 400×513 = 207,700) + all 4 spent shards (4 × (2500 + 400×1033)
// = 4 × 415,700) = 1,970,500 µA ≈ 1.97 ALGO. The deposit is not a pledge and is returned on delete().
const MIN_DEPOSIT = 1_970_500

// EMPTY[k] = sha256 of an empty subtree of height k; EMPTY[k] lives at bytes [k*32, (k+1)*32) of this constant.
const EMPTY = Bytes.fromHex(
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' +
    '2dba5dbc339e7316aea2683faf839c1b7b1ee2313db792112588118df066aa35' +
    '5310a330e8f970388503c73349d80b45cd764db615f1bced2801dcd4524a2ff4' +
    '80d1bf4dd6c1f75bba022337a3f0842078f5c2e7f3f59dfd33ccbb8e963367b2' +
    '1492e66e89e186840231850712161255d203b5bbf48d21242f0b51519b5eb3d4' +
    '03a82289eea21de37e72ad6c07865dcab3f2cd681ad47c1cd0ea30e1751ad996' +
    '35603b6278eb5d320c99eeb68354d448493e1ab9857cb0bddb9f7fa72250a3a8' +
    '8ff9103704f4e7dfee6106551eb439d3ac6bc5cc4873ced8ec33eaf2d42f4c31' +
    '259ca0ef3ecb66bb9f02e2ca9de6c7ff13951ad824ece4c680555cfef4321d17' +
    '4f52a2051143520841633a6e53f1ad5948a584dcdbc8ea206d8008d1cfe104a9' +
    '7ef919cf6137226a4c132f3bcab47a11aa1dfe78a357c19c0c804508829f2623' +
    'cbafa51c68b69bc206500c4733c2cc4cc6b67f712cc5fbad5b2d365998ba37a0' +
    'e11746324aa6ce20024a6e4796ae38d2dce7d5e015071a4a2cc96c9b71fafb32' +
    'e3b4036e156dd6ccf9e41e36b011fd00f79645e361d02a9484eaba96e3be7179' +
    'a3cbeb34d17bf5aa47054abd93e0ea1c992eef8359ad6a0f596ea48e455d540a' +
    'd1f9c8fa1339b232013cc9585b380372614a869fd0fd2e3d07bec2f3c96b4c6d',
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
   * @param deposit Payment from the creator that pre-funds the escrow's fixed storage MBR, so backers' pledges stay
   * fully refundable. Returned to the creator by delete().
   */
  @abimethod({ onCreate: 'require' })
  create(title: bytes, metadataUri: bytes, goal: uint64, deadline: uint64, deposit: gtxn.PaymentTxn): void {
    assert(Txn.applicationId.id === 0, 'must be called on app creation')
    assert(title.length > 0, 'title must not be empty')
    assert(title.length <= MAX_BYTES_PER_STATE_KEY, 'title too long')
    assert(metadataUri.length <= MAX_BYTES_PER_STATE_KEY, 'metadata uri too long')
    assert(goal > 0, 'goal must be greater than zero')
    assert(deadline > Global.latestTimestamp, 'deadline must be in the future')
    assert(deposit.sender === Txn.sender, 'deposit must come from the creator')
    assert(deposit.receiver === Global.currentApplicationAddress, 'deposit must be made to the campaign escrow')
    assert(deposit.amount >= MIN_DEPOSIT, 'deposit too small')

    this.creator.value = Txn.sender
    this.title.value = title
    this.metadataUri.value = metadataUri
    this.goal.value = goal
    this.deadline.value = deadline
    this.raised.value = 0
    this.status.value = STATUS_OPEN
    this.root.value = this.emptyNode(Uint64(TREE_HEIGHT))
    this.leafCount.value = 0
    this.deposit.value = deposit.amount
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

    this.append(this.leafHash(Txn.sender, payment.amount))
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
   * @param siblings The Merkle proof (h sibling hashes, from height 0 up).
   * @param index The leaf's slot index.
   * @param amount The pledged amount (bound to the leaf by the proof).
   */
  @abimethod()
  refund(siblings: bytes[], index: uint64, amount: uint64): void {
    assert(Global.latestTimestamp >= this.deadline.value, 'deadline has not passed')
    assert(this.raised.value < this.goal.value, 'goal was reached, no refunds')

    if (this.status.value === STATUS_OPEN) {
      this.status.value = STATUS_FAILED
    }
    assert(this.status.value === STATUS_FAILED, 'campaign is not refundable')

    this.verifyAndSpend(index, amount, siblings)

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
   * @param siblings The Merkle proof (h sibling hashes, from height 0 up).
   * @param index The leaf's slot index.
   * @param amount The pledged amount (bound to the leaf by the proof).
   */
  @abimethod()
  cancelPledge(siblings: bytes[], index: uint64, amount: uint64): void {
    assert(Global.latestTimestamp < this.deadline.value, 'pledging is closed')
    assert(this.status.value === STATUS_OPEN, 'campaign is not open')

    this.verifyAndSpend(index, amount, siblings)
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

  // Append a leaf hash to the tree: update the MMR frontier and the root.
  private append(leaf: bytes): void {
    let frontier = this.frontier.get({ default: op.bzero(FRONTIER_BYTES) })
    let node = leaf
    let k = Uint64(0)
    while (k <= Uint64(TREE_HEIGHT)) {
      const peak = op.extract(frontier, k * 32, 32)
      if (peak.equals(op.bzero(32))) {
        break
      }
      node = op.sha256(op.concat(peak, node))
      frontier = op.replace(frontier, k * 32, op.bzero(32))
      k = k + 1
    }
    frontier = op.replace(frontier, k * 32, node)
    this.frontier.value = frontier
    this.root.value = this.fold(frontier)
  }

  // Compute the empty-padded fold of the MMR frontier (the current tree root).
  private fold(frontier: bytes): bytes {
    let acc: bytes = op.bzero(0)
    let hasAcc = false
    let accHeight = Uint64(0)
    let k = Uint64(0)
    while (k <= Uint64(TREE_HEIGHT)) {
      const peak = op.extract(frontier, k * 32, 32)
      if (!peak.equals(op.bzero(32))) {
        if (!hasAcc) {
          acc = peak
          accHeight = k
          hasAcc = true
        } else {
          while (accHeight < k) {
            acc = op.sha256(op.concat(acc, this.emptyNode(accHeight)))
            accHeight = accHeight + 1
          }
          acc = op.sha256(op.concat(peak, acc))
          accHeight = k + 1
        }
      }
      k = k + 1
    }
    if (!hasAcc) {
      return this.emptyNode(Uint64(TREE_HEIGHT))
    }
    while (accHeight < Uint64(TREE_HEIGHT)) {
      acc = op.sha256(op.concat(acc, this.emptyNode(accHeight)))
      accHeight = accHeight + 1
    }
    return acc
  }

  // Verify the caller's proof and mark the leaf spent, atomically.
  private verifyAndSpend(index: uint64, amount: uint64, siblings: bytes[]): void {
    let node: bytes = op.sha256(op.concat(Txn.sender.bytes, op.itob(amount)))
    let k = Uint64(0)
    for (const sibling of siblings) {
      if (((index >> k) & 1) === 0) {
        node = op.sha256(op.concat(node, sibling))
      } else {
        node = op.sha256(op.concat(sibling, node))
      }
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

  /** The spendable ALGO held at the escrow address (total minus the minimum balance). */
  private escrowBalance(): uint64 {
    const balance = Global.currentApplicationAddress.balance
    return balance - Global.currentApplicationAddress.minBalance
  }
}
