import type { Account, bytes, gtxn, uint64 } from '@algorandfoundation/algorand-typescript'
import { BoxMap, Contract, Global, GlobalState, Txn, abimethod, assert, itxn } from '@algorandfoundation/algorand-typescript'

/**
 * Campaign — a non-custodial crowdfunding escrow.
 *
 * One stateful application per campaign. Pledged ALGO is held at the app's escrow address and released by the contract itself, based purely
 * on the on-chain state and the transaction group presented by the caller.
 *
 * State machine: Open -> Funded (deadline passed & raised >= goal) Open -> Failed (deadline passed & raised < goal) Funded -> Claimed
 * (creator claims escrow balance) Failed -> Refunded (each backer reclaims their pledge)
 */

// Status is stored in global state as a uint64.
// 0 = Open, 1 = Failed, 2 = Claimed.
// "Funded" is a derived state (deadline passed && raised >= goal); there is no
// separate settle call, so it is never materialised into global state.
const STATUS_OPEN = 0
const STATUS_FAILED = 1
const STATUS_CLAIMED = 2

// A single bytes global-state value is capped at 128 bytes on the AVM.
const MAX_BYTES_PER_STATE_KEY = 128

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

  /** One box per backer, keyed by address, holding their pledged amount in microAlgos. */
  pledges = BoxMap<Account, uint64>({ keyPrefix: 'p' })

  /**
   * Deploy the campaign.
   *
   * Called as part of the app-create transaction, so this must run with `Txn.applicationId == 0`. `goal` must be greater than zero and the
   * `deadline` must be in the future. `title` is stored on-chain for cheap list rendering; `metadataUri` points to the off-chain metadata
   * (description, image, category).
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
  }

  /**
   * Pledge ALGO to the campaign.
   *
   * The caller submits this app call in a group with a payment transaction from their own account to the app's escrow address. The contract
   * verifies the payment is valid and records the amount in the backer's box.
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

    // A backer can pledge more than once; each payment is added to their box.
    // `.get({ default: 0 })` handles the first pledge, where the box doesn't exist yet.
    const current = this.pledges(Txn.sender).get({ default: 0 })
    this.pledges(Txn.sender).value = current + payment.amount

    this.raised.value = this.raised.value + payment.amount
  }

  /**
   * Release the escrow balance to the creator.
   *
   * Only the creator may call, only once the deadline has passed and only if the goal was reached. The outcome is first materialised into
   * global state so the indexer can observe it, then the balance is paid out.
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
   * Only available after the deadline has passed and the goal was NOT reached. Each backer can reclaim their own pledge, once; a second
   * attempt fails because their box no longer exists.
   */
  @abimethod()
  refund(): void {
    assert(Global.latestTimestamp >= this.deadline.value, 'deadline has not passed')
    assert(this.raised.value < this.goal.value, 'goal was reached, no refunds')

    // Materialise the failed outcome the first time anyone triggers a refund.
    if (this.status.value === STATUS_OPEN) {
      this.status.value = STATUS_FAILED
    }
    assert(this.status.value === STATUS_FAILED, 'campaign is not refundable')

    const backer = Txn.sender
    const pledgeBox = this.pledges(backer)
    assert(pledgeBox.exists, 'nothing to refund')

    const amount = pledgeBox.value
    pledgeBox.delete()

    itxn
      .payment({
        receiver: backer,
        amount: amount,
      })
      .submit()
  }

  /**
   * Withdraw a backer's pledge before the deadline.
   *
   * Only available while the campaign is still open (before the deadline). Deletes the caller's pledge box, pays the amount back and
   * decrements `raised`; the box delete makes a second cancel impossible (same pattern as `refund`).
   */
  @abimethod()
  cancelPledge(): void {
    assert(Global.latestTimestamp < this.deadline.value, 'pledging is closed')
    assert(this.status.value === STATUS_OPEN, 'campaign is not open')

    const backer = Txn.sender
    const pledgeBox = this.pledges(backer)
    assert(pledgeBox.exists, 'nothing to cancel')

    const amount = pledgeBox.value
    pledgeBox.delete()
    this.raised.value = this.raised.value - amount

    itxn
      .payment({
        receiver: backer,
        amount: amount,
      })
      .submit()
  }

  /** The spendable ALGO held at the escrow address (total minus the minimum balance). */
  private escrowBalance(): uint64 {
    const balance = Global.currentApplicationAddress.balance
    return balance - Global.currentApplicationAddress.minBalance
  }
}
