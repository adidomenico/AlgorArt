import type { bytes, gtxn, uint64 } from '@algorandfoundation/algorand-typescript'
import {
  Account,
  Asset,
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
 * Campaign — a non-custodial crowdfunding escrow whose backer records live in a **Claim ASA**.
 *
 * One stateful application per campaign. Pledged ALGO is held at the app's escrow address and released by the contract itself, based purely
 * on the on-chain state and the transaction group presented by the caller.
 *
 * The right to a refund is itself an on-chain asset balance: on `pledge`, the campaign mints the same number of **claim units** of its own
 * Claim ASA to the backer (1 unit = 1 microAlgo). A refund or cancellation is the reverse — the backer surrenders claim units to the escrow
 * and receives the same amount of ALGO. Because the units are destroyed from the backer's balance by the surrender, the same claim cannot
 * be redeemed twice: the ASA balance *is* the anti-double-refund state. No Merkle tree, spent bitmap, boxes, or local state are needed, so
 * the campaign's own storage is a small constant regardless of the number of backers.
 *
 * The Claim ASA is a bearer instrument: it is freely transferable, and whoever holds the units at settlement time is entitled to the
 * refund. It is created and managed by the campaign itself via inner transactions (manager = the escrow), so no third party is trusted.
 */

// Status is stored in global state as a uint64.
// 0 = Open, 1 = Failed, 2 = Claimed.
const STATUS_OPEN = 0
const STATUS_FAILED = 1
const STATUS_CLAIMED = 2

// A single bytes global-state value is capped at 128 bytes on the AVM.
const MAX_BYTES_PER_STATE_KEY = 128

// The Claim ASA total supply: 2^64 - 1 units. The ASA total is immutable after creation, so the campaign mints units from this fixed pool.
// The real cap is the ALGO total supply (~10^16 µA), far below 2^64 - 1, so the pool can never run dry.
const TOTAL_CLAIM_UNITS = Uint64.MAX_VALUE

// The escrow's minimum balance once the Claim ASA exists: 100,000 (account base) + 100,000 (created asset) = 200,000 µA (the asset's
// creator needs no extra opt-in — the supply holding is implicit). The creator fronts this via `fund()` so backers' pledges stay 100%
// refundable. Measured on LocalNet; see docs/campaign.md.
const MIN_DEPOSIT = 200_000

export class Campaign extends Contract {
  /** Address of the creator — the only account allowed to claim and delete. */
  creator = GlobalState<Account>()

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

  /** The campaign's Claim ASA id; 0 until `fund()` issues it. */
  claimAsa = GlobalState<uint64>({ initialValue: 0 })

  /** Storage deposit the creator fronts at `fund()` to cover the escrow's fixed minimum balance. */
  deposit = GlobalState<uint64>({ initialValue: 0 })

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
    this.claimAsa.value = 0
    this.deposit.value = 0
  }

  /**
   * Fund the campaign's storage deposit and issue the Claim ASA.
   *
   * The creator pays ALGO into the escrow to cover the fixed storage minimum balance (the escrow's account base plus the Claim ASA's
   * created-asset and opt-in cost, 300,000 µA total), so backers' pledges stay fully refundable. The same call creates the Claim ASA via
   * an inner transaction: total supply `2^64 - 1`, `manager` = the escrow (so only this contract can later destroy it), no reserve, no
   * freeze, no clawback — the claim is a freely transferable bearer instrument. The deposit is accumulated and returned to the creator by
   * `delete()`.
   *
   * @param payment Payment from the creator to the campaign escrow.
   */
  @abimethod()
  fund(payment: gtxn.PaymentTxn): void {
    assert(Txn.sender === this.creator.value, 'only the creator can fund')
    assert(this.status.value === STATUS_OPEN, 'campaign is not open')
    assert(this.claimAsa.value === Uint64(0), 'claim asset already issued')
    assert(payment.sender === Txn.sender, 'payment must come from the caller')
    assert(payment.receiver === Global.currentApplicationAddress, 'payment must be made to the campaign escrow')
    assert(payment.amount >= MIN_DEPOSIT, 'fund must cover the escrow minimum balance')

    const created = itxn
      .assetConfig({
        total: TOTAL_CLAIM_UNITS,
        decimals: Uint64(0),
        unitName: Bytes('CLAIM'),
        assetName: Bytes('AlgorArt Claim'),
        manager: Global.currentApplicationAddress,
        fee: Uint64(0),
      })
      .submit()

    this.claimAsa.value = created.createdAsset.id
    this.deposit.value = payment.amount
  }

  /**
   * Pledge ALGO to the campaign.
   *
   * The caller submits this app call in a group with a payment from their own account to the escrow. The contract mints the same number
   * of Claim ASA units to the caller via an inner asset transfer (the backer must already be opted in to the Claim ASA — otherwise the
   * whole group reverts).
   *
   * @param payment Payment from the caller to the campaign escrow.
   */
  @abimethod()
  pledge(payment: gtxn.PaymentTxn): void {
    assert(Global.latestTimestamp < this.deadline.value, 'pledging is closed')
    assert(this.status.value === STATUS_OPEN, 'campaign is not open')
    assert(payment.receiver === Global.currentApplicationAddress, 'payment must be made to the campaign escrow')
    assert(payment.sender === Txn.sender, 'payment must come from the caller')
    assert(payment.amount > 0, 'pledge must be greater than zero')
    assert(Txn.sender !== this.creator.value, 'creator cannot pledge to their own campaign')
    assert(this.claimAsa.value !== Uint64(0), 'claim asset not issued yet')

    itxn
      .assetTransfer({
        xferAsset: this.claimAsa.value,
        assetReceiver: Txn.sender,
        assetAmount: payment.amount,
        fee: Uint64(0),
      })
      .submit()

    this.raised.value = this.raised.value + payment.amount
  }

  /**
   * Release the escrow balance to the creator.
   *
   * Only the creator may call, only once the deadline has passed and only if the goal was reached. The claim units then stop representing
   * a refundable claim — backers may still surrender them via `closeOut()` so the escrow can be swept.
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
        fee: Uint64(0),
      })
      .submit()
  }

  /**
   * Return a backer's pledge after a failed campaign.
   *
   * Only after the deadline, when the goal was not reached. The backer surrenders claim units to the escrow in the same group (an asset
   * transfer to the escrow address) and receives the same number of microAlgos back. Because the surrendered units leave the caller's
   * balance, the same claim cannot be redeemed twice — no other anti-double-spend state exists or is needed.
   *
   * @param axfer Asset transfer from the caller to the escrow, of the campaign's Claim ASA.
   */
  @abimethod()
  refund(axfer: gtxn.AssetTransferTxn): void {
    assert(Global.latestTimestamp >= this.deadline.value, 'deadline has not passed')
    assert(this.raised.value < this.goal.value, 'goal was reached, no refunds')

    if (this.status.value === STATUS_OPEN) {
      this.status.value = STATUS_FAILED
    }
    assert(this.status.value === STATUS_FAILED, 'campaign is not refundable')

    this.verifySurrender(axfer)

    itxn
      .payment({
        receiver: Txn.sender,
        amount: axfer.assetAmount,
        fee: Uint64(0),
      })
      .submit()

    this.raised.value = this.raised.value - axfer.assetAmount
  }

  /**
   * Withdraw a backer's pledge before the deadline.
   *
   * The explicit, safe cancellation path while the campaign is open: the holder surrenders claim units and receives the same amount of
   * ALGO back; `raised` is decremented so the goal check stays honest. With bearer claim units, any holder can cancel — which is exactly
   * "the current holder is entitled to the refund".
   *
   * @param axfer Asset transfer from the caller to the escrow, of the campaign's Claim ASA.
   */
  @abimethod()
  cancelPledge(axfer: gtxn.AssetTransferTxn): void {
    assert(Global.latestTimestamp < this.deadline.value, 'pledging is closed')
    assert(this.status.value === STATUS_OPEN, 'campaign is not open')

    this.verifySurrender(axfer)

    itxn
      .payment({
        receiver: Txn.sender,
        amount: axfer.assetAmount,
        fee: Uint64(0),
      })
      .submit()

    this.raised.value = this.raised.value - axfer.assetAmount
  }

  /**
   * Close out a claim holding on a successful campaign.
   *
   * After `claim()` the claim units no longer represent a refundable claim. A holder can close their Claim ASA holding back to the escrow
   * (asset transfer with `closeRemainderTo` = the escrow), recovering their own 0.1 ALGO opt-in minimum balance. Nothing is paid out. Once
   * every holder has closed out, the escrow again holds the entire ASA supply and the creator can `delete()` the campaign.
   *
   * @param axfer Asset transfer from the caller to the escrow closing the caller's Claim ASA holding.
   */
  @abimethod()
  closeOut(axfer: gtxn.AssetTransferTxn): void {
    assert(this.status.value === STATUS_CLAIMED, 'campaign is not claimed')
    assert(axfer.sender === Txn.sender, 'claim units must come from the caller')
    assert(axfer.assetReceiver === Global.currentApplicationAddress, 'claim units must go to the campaign escrow')
    assert(axfer.xferAsset.id === this.claimAsa.value, 'wrong claim asset')
    assert(axfer.assetCloseTo === Global.currentApplicationAddress, 'must close the claim holding to the escrow')
  }

  /**
   * Delete the campaign application and recover the residual ALGO.
   *
   * Creator only, and only when settled: the campaign may not have live pledges (an open campaign with `raised == 0` is deletable — nobody
   * is owed anything). The Claim ASA may only be destroyed when the escrow holds the entire supply, which is checked directly against the
   * escrow's own asset balance, so a delete can never strand a backer's units. The ASA is destroyed first (freeing its minimum balance),
   * then the escrow is closed with `CloseRemainderTo`, returning the residual (the deposit) to the creator and freeing their sponsorship
   * floor.
   */
  @abimethod({ allowActions: 'DeleteApplication' })
  delete(): void {
    assert(Txn.sender === this.creator.value, 'only the creator can delete')
    assert(this.status.value !== STATUS_OPEN || this.raised.value === Uint64(0), 'cannot delete a campaign with live pledges')

    /* v8 ignore next 9 — the supply check + destroy only run when the escrow holds the whole supply; the offline ledger can't
     * emulate asset holdings, so this path is covered by the LocalNet integration tests (contract.integration.test.ts). */
    if (this.claimAsa.value !== Uint64(0)) {
      const held = op.AssetHolding.assetBalance(Global.currentApplicationAddress, Asset(this.claimAsa.value))[0]
      assert(held === TOTAL_CLAIM_UNITS, 'claim units outstanding')

      itxn
        .assetConfig({
          configAsset: this.claimAsa.value,
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
   * Validate a surrender asset transfer for `refund`/`cancelPledge`: from the caller to the escrow, of the Claim ASA, a positive amount,
   * and without `closeRemainderTo` (so the exact amount received equals `assetAmount` and the payout is exact).
   *
   * @param axfer The asset transfer to validate.
   */
  private verifySurrender(axfer: gtxn.AssetTransferTxn): void {
    assert(axfer.sender === Txn.sender, 'claim units must come from the caller')
    assert(axfer.assetReceiver === Global.currentApplicationAddress, 'claim units must go to the campaign escrow')
    assert(axfer.xferAsset.id === this.claimAsa.value, 'wrong claim asset')
    assert(axfer.assetAmount > 0, 'claim amount must be greater than zero')
    assert(
      axfer.assetCloseTo === Account(Bytes.fromHex('0000000000000000000000000000000000000000000000000000000000000000')),
      'close-out is not allowed here',
    )
  }

  /** The spendable ALGO held at the escrow address (total minus the minimum balance). */
  private escrowBalance(): uint64 {
    const balance = Global.currentApplicationAddress.balance
    return balance - Global.currentApplicationAddress.minBalance
  }
}
