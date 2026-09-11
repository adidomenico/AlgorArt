import type { Application, Asset, bytes, gtxn, uint64 } from '@algorandfoundation/algorand-typescript'
import {
  Account,
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
 * Campaign — a non-custodial crowdfunding campaign whose escrow is split from the backers' refund pool.
 *
 * One stateful application per campaign. The campaign escrow holds **only the creator's storage deposit**; backers' pledged ALGO goes to
 * the permanent **ClaimsVault**, which issues the campaign's Claim ASA (seeding its whole supply to the campaign app), holds all pledges,
 * and pays refunds, cancellations, and successful claims. The right to a refund is a Claim ASA balance: a pledge of X microAlgos mints X
 * claim units to the backer, and a refund/cancellation surrenders X units (to the vault) in exchange for X microAlgos — the asset ledger
 * itself is the anti-double-refund state.
 *
 * Because no backer funds ever sit in the campaign escrow, the creator can finalize (and delete) the campaign in O(1) on **both** paths
 * — after a successful claim, or after a failure, even when backers never act — while the vault keeps paying failed-campaign refunds
 * forever, after the campaign is gone. See docs/claim-asa-redesign.md for the design and its security analysis.
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
const TOTAL_CLAIM_UNITS = Uint64(0xffff_ffff_ffff_ffffn)

// The escrow's minimum balance once the Claim ASA exists: 100,000 (account base) + 100,000 (opt-in holding) = 200,000 µA. The creator
// fronts this via `fund()`; backers' pledges never touch the escrow, so the deposit is always fully recoverable by `delete()`.
const MIN_DEPOSIT = 200_000

// ARC-4 method selectors for the ClaimsVault methods this contract invokes as inner app calls (computed from the emitted ARC-56
// signatures — see smart_contracts/claimsvault/contract.algo.ts; kept in sync by the integration tests).
const VAULT_PAY_BACK_SELECTOR = Bytes.fromHex('b0e0eedf') // payBack(uint64,address,uint64)void
const VAULT_PAY_CLAIM_SELECTOR = Bytes.fromHex('f8c4e0cb') // payClaim(uint64)void
const VAULT_SETTLE_SELECTOR = Bytes.fromHex('58a020de') // settle(uint64)void

export class Campaign extends Contract {
  /** Address of the creator — the only account allowed to claim and delete. */
  creator = GlobalState<Account>()

  /** The ClaimsVault app — the pooled refund escrow that holds pledges and pays refunds/claims. */
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

  /** The campaign's Claim ASA id; 0 until `attachClaimAsa()` records it. */
  claimAsa = GlobalState<uint64>({ initialValue: 0 })

  /** Storage deposit the creator fronts at `fund()` to cover the escrow's fixed minimum balance. */
  deposit = GlobalState<uint64>({ initialValue: 0 })

  /**
   * Deploy the campaign.
   *
   * @param vault The ClaimsVault app that will issue the Claim ASA and hold the backers' pledges.
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
    this.claimAsa.value = 0
    this.deposit.value = 0
  }

  /**
   * Fund the campaign's storage deposit.
   *
   * The creator pays ALGO into the escrow to cover the fixed storage minimum balance (account base + the Claim ASA opt-in, 200,000 µA
   * total). The deposit is the only capital the escrow ever holds — backers' pledges go to the vault — and it is returned in full by
   * `delete()`.
   *
   * @param payment Payment from the creator to the campaign escrow.
   */
  @abimethod()
  fund(payment: gtxn.PaymentTxn): void {
    assert(Txn.sender === this.creator.value, 'only the creator can fund')
    assert(this.status.value === STATUS_OPEN, 'campaign is not open')
    assert(this.claimAsa.value === Uint64(0), 'claim asset already attached')
    assert(payment.sender === Txn.sender, 'payment must come from the caller')
    assert(payment.receiver === Global.currentApplicationAddress, 'payment must be made to the campaign escrow')
    assert(payment.amount >= MIN_DEPOSIT, 'fund must cover the escrow minimum balance')

    this.deposit.value = payment.amount
  }

  /**
   * Record the vault-issued Claim ASA and opt the escrow in.
   *
   * Permissionless: the asset's provenance is verified against the stored vault — only an asset created and managed by that vault is
   * accepted, so a campaign whose creator stored a fake vault address can never attach any asset and is inert (pledges reject with
   * "claim asset not issued yet"). The escrow self-opts in (its minimum balance is covered by the `fund()` deposit), after which the
   * vault seeds the supply via `seedSupply`. Attach once.
   *
   * @param asset The Claim ASA issued by the vault for this campaign.
   */
  @abimethod()
  attachClaimAsa(asset: Asset): void {
    assert(this.claimAsa.value === Uint64(0), 'claim asset already attached')
    assert(asset.creator === this.vault.value.address, 'not issued by the vault')
    assert(asset.manager === this.vault.value.address, 'not managed by the vault')
    assert(asset.clawback === this.vault.value.address, 'vault must hold the clawback authority')
    assert(asset.total === TOTAL_CLAIM_UNITS, 'wrong claim asset supply')
    assert(asset.decimals === Uint64(0), 'wrong claim asset decimals')

    itxn
      .assetTransfer({
        xferAsset: asset,
        assetReceiver: Global.currentApplicationAddress,
        assetAmount: Uint64(0),
        fee: Uint64(0),
      })
      .submit()

    this.claimAsa.value = asset.id
  }

  /**
   * Pledge ALGO to the campaign.
   *
   * The caller submits this app call in a group with a payment from their own account **to the vault** (the pooled refund escrow). The
   * contract mints the same number of Claim ASA units to the caller via an inner asset transfer (the backer must already be opted in to
   * the Claim ASA — otherwise the whole group reverts).
   *
   * @param payment Payment from the caller to the vault.
   */
  @abimethod()
  pledge(payment: gtxn.PaymentTxn): void {
    assert(Global.latestTimestamp < this.deadline.value, 'pledging is closed')
    assert(this.status.value === STATUS_OPEN, 'campaign is not open')
    assert(payment.receiver === this.vault.value.address, 'payment must be made to the vault')
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
   * Release the campaign funds to the creator.
   *
   * Only the creator may call, only once the deadline has passed and only if the goal was reached. The campaign sets its status to
   * Claimed and asks the vault (via an inner app call) to pay the creator — the vault derives the payout from unit conservation
   * (`total − vault holding − campaign holding`), i.e. exactly the live pledge total. The claim units then stop representing a refundable
   * claim.
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
   * Return a backer's pledge after a failed campaign.
   *
   * Only after the deadline, when the goal was not reached. The backer surrenders claim units **to the vault** in the same group and
   * receives the same number of microAlgos back — paid by the vault via an inner app call. Because the surrendered units leave the
   * caller's balance, the same claim cannot be redeemed twice.
   *
   * @param axfer Asset transfer from the caller to the vault, of the campaign's Claim ASA.
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
      .applicationCall({
        appId: this.vault.value,
        appArgs: [VAULT_PAY_BACK_SELECTOR, op.itob(Global.currentApplicationId.id), Txn.sender.bytes, op.itob(axfer.assetAmount)],
        fee: Uint64(0),
      })
      .submit()

    this.raised.value = this.raised.value - axfer.assetAmount
  }

  /**
   * Withdraw a backer's pledge before the deadline.
   *
   * The explicit, safe cancellation path while the campaign is open: the holder surrenders claim units to the vault and receives the same
   * amount of ALGO back; `raised` is decremented so the goal check stays honest. With bearer claim units, any holder can cancel — which
   * is exactly "the current holder is entitled to the refund".
   *
   * @param axfer Asset transfer from the caller to the vault, of the campaign's Claim ASA.
   */
  @abimethod()
  cancelPledge(axfer: gtxn.AssetTransferTxn): void {
    assert(Global.latestTimestamp < this.deadline.value, 'pledging is closed')
    assert(this.status.value === STATUS_OPEN, 'campaign is not open')

    this.verifySurrender(axfer)

    itxn
      .applicationCall({
        appId: this.vault.value,
        appArgs: [VAULT_PAY_BACK_SELECTOR, op.itob(Global.currentApplicationId.id), Txn.sender.bytes, op.itob(axfer.assetAmount)],
        fee: Uint64(0),
      })
      .submit()

    this.raised.value = this.raised.value - axfer.assetAmount
  }

  /**
   * Close out a claim holding on a successful campaign.
   *
   * After `claim()` the claim units no longer represent a refundable claim. A holder can close their Claim ASA holding back to the vault
   * (asset transfer with `closeRemainderTo` = the vault), recovering their own 0.1 ALGO opt-in minimum balance. Nothing is paid out.
   *
   * @param axfer Asset transfer from the caller to the vault closing the caller's Claim ASA holding.
   */
  @abimethod()
  closeOut(axfer: gtxn.AssetTransferTxn): void {
    assert(this.status.value === STATUS_CLAIMED, 'campaign is not claimed')
    assert(axfer.sender === Txn.sender, 'claim units must come from the caller')
    assert(axfer.assetReceiver === this.vault.value.address, 'claim units must go to the vault')
    assert(axfer.xferAsset.id === this.claimAsa.value, 'wrong claim asset')
    assert(axfer.assetCloseTo === this.vault.value.address, 'must close the claim holding to the vault')
  }

  /**
   * Delete the campaign application and recover the residual ALGO.
   *
   * Creator only. The escrow never holds backer funds, so deletion is O(1) on **both** settlement paths, even when backers never act:
   *
   * - **Claimed** — the settlement was recorded at `claim()`; the escrow's claim-unit holding is closed back to the vault and the escrow
   *   is closed to the creator.
   * - **Failed in fact** (deadline passed, goal not reached, still Open) — the status is materialized and the vault is asked (inner app
   *   call) to record the failed settlement, after which backers keep refunding **directly from the vault forever**, even with the
   *   campaign deleted. Then the holding is closed to the vault and the escrow to the creator.
   * - **Abandoned** (Open with `raised == 0` — every unit returned) — nobody is owed anything; plain cleanup.
   *
   * Closing the holding (rather than destroying the ASA) is always safe: the Claim ASA stays alive under the vault, and outstanding
   * units remain valid objects in backers' wallets.
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

    if (this.claimAsa.value !== Uint64(0)) {
      if (this.status.value === STATUS_FAILED) {
        itxn
          .applicationCall({
            appId: this.vault.value,
            appArgs: [VAULT_SETTLE_SELECTOR, op.itob(Global.currentApplicationId.id)],
            fee: Uint64(0),
          })
          .submit()
      }

      itxn
        .assetTransfer({
          xferAsset: this.claimAsa.value,
          assetReceiver: this.vault.value.address,
          assetAmount: Uint64(0),
          assetCloseTo: this.vault.value.address,
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
   * Validate a surrender asset transfer for `refund`/`cancelPledge`: from the caller to the vault, of the Claim ASA, a positive amount,
   * and without `closeRemainderTo` (so the exact amount received equals `assetAmount` and the payout is exact).
   *
   * @param axfer The asset transfer to validate.
   */
  private verifySurrender(axfer: gtxn.AssetTransferTxn): void {
    assert(axfer.sender === Txn.sender, 'claim units must come from the caller')
    assert(axfer.assetReceiver === this.vault.value.address, 'claim units must go to the vault')
    assert(axfer.xferAsset.id === this.claimAsa.value, 'wrong claim asset')
    assert(axfer.assetAmount > 0, 'claim amount must be greater than zero')
    assert(
      axfer.assetCloseTo === Account(Bytes.fromHex('0000000000000000000000000000000000000000000000000000000000000000')),
      'close-out is not allowed here',
    )
  }
}
