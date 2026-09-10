import type { Account, Application, bytes, gtxn, uint64 } from '@algorandfoundation/algorand-typescript'
import {
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
 * Factory — the canonical, on-chain registry for AlgorArt campaigns.
 *
 * The Factory is **not** a shared escrow: every campaign keeps its own application account and its own funds. The Factory's only job is
 * authenticity and registration — it verifies that a new `Campaign` app runs the official AlgorArt approval program (by SHA-256 hash) and
 * records `app id → creator`, so the frontend can tell official campaigns apart from arbitrary copies of the contract.
 *
 * Registration costs a small, refundable deposit (the registration box's minimum balance, ~0.019 ALGO), paid to the Factory account and
 * returned by `unregister()` when the creator deletes their campaign. The Factory takes no part in pledging, refunding, or cleanup — it
 * is never a bottleneck and never performs per-backer operations.
 */

// Minimum balance of one registration box: 2,500 + 400 × (name bytes + value bytes) = 2,500 + 400 × (9 + 32) µA.
const REGISTER_MBR = 18_900

export class Factory extends Contract {
  /** The platform owner — the only account allowed to configure the official approval hash. */
  owner = GlobalState<Account>()

  /** SHA-256 of the official Campaign approval program; set by the owner. Empty until configured. */
  approvalHash = GlobalState<bytes>()

  /** Registered campaigns: app id → campaign creator. */
  registered = BoxMap<uint64, Account>({ keyPrefix: 'r' })

  /**
   * Deploy the Factory.
   *
   * The platform funds the Factory's application account (at least the 0.1 ALGO account base) after creation, so it can hold the
   * registration deposits and pay them back on `unregister()`.
   */
  @abimethod({ onCreate: 'require' })
  create(): void {
    assert(Txn.applicationId.id === 0, 'must be called on app creation')
    this.owner.value = Txn.sender
    this.approvalHash.value = Bytes()
  }

  /**
   * Set the official Campaign approval-program hash.
   *
   * Owner only. Registration is refused until this is configured. Updating the hash (e.g. after a contract upgrade) makes old program
   * versions unregisterable while existing registrations stay.
   *
   * @param hash The SHA-256 digest of the official Campaign approval program.
   */
  @abimethod()
  setApprovalHash(hash: bytes): void {
    assert(Txn.sender === this.owner.value, 'only the owner can set the approval hash')
    assert(hash.length === 32, 'approval hash must be 32 bytes')
    this.approvalHash.value = hash
  }

  /**
   * Register a newly created Campaign app.
   *
   * Anyone may call, but only the campaign's creator can register it: the calling application's approval program must hash to the official
   * `approvalHash`, and its creator must be the caller. The caller pays a refundable deposit covering the registration box's minimum
   * balance; `unregister()` returns it when the campaign is deleted.
   *
   * @param app The deployed Campaign application (its approval program is verified).
   * @param payment Payment from the caller to the Factory account, covering the registration deposit.
   */
  @abimethod()
  register(app: Application, payment: gtxn.PaymentTxn): void {
    assert(this.approvalHash.value.length === 32, 'official approval hash not configured')
    assert(app.creator === Txn.sender, 'only the campaign creator can register')
    assert(payment.sender === Txn.sender, 'payment must come from the caller')
    assert(payment.receiver === Global.currentApplicationAddress, 'payment must be made to the factory')
    assert(payment.amount >= REGISTER_MBR, 'registration deposit too small')
    assert(!this.registered(app.id).exists, 'campaign already registered')
    assert(op.sha256(app.approvalProgram) === this.approvalHash.value, 'not an official AlgorArt campaign')

    this.registered(app.id).value = Txn.sender
  }

  /**
   * Unregister a campaign and recover the registration deposit.
   *
   * Only the registered creator may call; the registration box is deleted (freeing its minimum balance on the Factory account) and the
   * deposit is paid back to the creator. Callers unregister when their campaign app has been deleted.
   *
   * @param app The registered Campaign application.
   */
  @abimethod()
  unregister(app: Application): void {
    assert(this.registered(app.id).exists, 'campaign is not registered')
    assert(this.registered(app.id).value === Txn.sender, 'only the campaign creator can unregister')

    this.registered(app.id).delete()

    itxn
      .payment({
        receiver: Txn.sender,
        amount: REGISTER_MBR,
        fee: Uint64(0),
      })
      .submit()
  }

  /**
   * Whether an application is registered as an official AlgorArt campaign.
   *
   * @param app The application to check.
   * @returns True when the app is registered.
   */
  @abimethod({ readonly: true })
  isRegistered(app: Application): boolean {
    return this.registered(app.id).exists
  }
}
