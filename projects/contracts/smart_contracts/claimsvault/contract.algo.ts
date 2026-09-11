import type { Application, gtxn, uint64 } from '@algorandfoundation/algorand-typescript'
import {
  Account,
  Asset,
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
 * ClaimsVault — the permanent, pooled refund escrow for AlgorArt campaigns.
 *
 * The vault separates **backers' pledged ALGO** from the **creator's campaign capital**: pledges are paid to the vault (verified by the
 * campaign's `pledge()`), the vault issues each campaign's Claim ASA and seeds its whole supply to the campaign app, and the vault alone
 * pays out refunds, cancellations, and successful claims. Because the campaign escrow never holds backer funds, the creator can finalize
 * (and delete the campaign) in O(1) even when backers never act — while the vault keeps paying refunds forever, after the campaign is
 * gone, driven only by the surrender of claim units.
 *
 * The vault holds all campaigns' funds in one pooled account. Cross-campaign isolation is enforced by the claim-unit ledger itself:
 * every unit is minted only against a pledge payment verified into the vault, every cancel/refund pays exactly the surrendered units, and
 * the claim payout is *derived* from unit conservation (`total − vault holding − campaign holding`) rather than trusted to any caller.
 * Per-campaign state is O(1) (a few boxes); the vault's own parked minimum balance per issued ASA is the one accepted protocol cost.
 *
 * Trust model: `payBack`, `payClaim`, and `settle` are reachable only as inner app calls from the campaign's own app account (matched
 * via the `addressOf` mapping recorded at issuance), and the campaign program is hash-verified at Factory registration and non-updatable.
 */

// Settlement outcomes stored in the `settled` box: 1 = Failed (permanent refunds), 2 = Claimed (no refunds).
const STATUS_FAILED = 1
const STATUS_CLAIMED = 2

// The Claim ASA total supply: 2^64 - 1 units (the real cap is the ALGO total supply, far below).
const TOTAL_CLAIM_UNITS = Uint64(0xffff_ffff_ffff_ffffn)

export class ClaimsVault extends Contract {
  /** The Factory registry app id; its `registered` boxes are the canonical campaign/creator records. */
  factory = GlobalState<uint64>()

  /** Campaign app id → its Claim ASA id. */
  asaOf = BoxMap<uint64, uint64>({ keyPrefix: 'a' })

  /** Campaign app id → the campaign app's account address (the only account allowed to drive payouts). */
  addressOf = BoxMap<uint64, Account>({ keyPrefix: 'd' })

  /** Campaign app id → the campaign creator (the claim payout recipient). */
  creatorOf = BoxMap<uint64, Account>({ keyPrefix: 'o' })

  /** Campaign app id → settlement outcome (1 Failed / 2 Claimed); absent until settled. */
  settled = BoxMap<uint64, uint64>({ keyPrefix: 's' })

  /**
   * Deploy the vault.
   *
   * The platform funds the vault's application account after creation (the account base plus headroom; each issued ASA parks ~0.1 ALGO
   * of created-asset MBR, recovered only when the ASA is eventually destroyed via `destroyClaimAsa`).
   *
   * @param factory The Factory registry app.
   */
  @abimethod({ onCreate: 'require' })
  create(factory: Application): void {
    assert(Txn.applicationId.id === 0, 'must be called on app creation')
    this.factory.value = factory.id
  }

  /**
   * Issue a registered campaign's Claim ASA: create it (manager/clawback/reserve = the vault) and record the mappings. The campaign then
   * records it via its `attachClaimAsa` (provenance-verified, escrow self-opt-in) and this vault seeds the whole supply via `seedSupply`.
   *
   * The campaign's approval program must hash to the Factory's configured official hash (so copies of the contract are no more than
   * ordinary campaigns — byte-identical code — while modified programs are refused), and the caller must be the campaign's creator.
   *
   * @param app The campaign application.
   */
  @abimethod()
  issueClaimAsa(app: Application): void {
    assert(this.asaOf(app.id).get({ default: Uint64(0) }) === Uint64(0), 'claim asset already issued')

    const official = op.AppGlobal.getExBytes(this.factory.value, Bytes('approvalHash'))
    assert(official[1], 'factory approval hash not configured')
    assert(op.sha256(app.approvalProgram) === official[0], 'not an official AlgorArt campaign')
    assert(app.creator === Txn.sender, 'only the campaign creator can issue')

    const created = itxn
      .assetConfig({
        total: TOTAL_CLAIM_UNITS,
        decimals: Uint64(0),
        unitName: Bytes('CLAIM'),
        assetName: Bytes('AlgorArt Claim'),
        manager: Global.currentApplicationAddress,
        clawback: Global.currentApplicationAddress,
        reserve: Global.currentApplicationAddress,
        fee: Uint64(0),
      })
      .submit()

    const assetId = created.createdAsset.id
    this.asaOf(app.id).value = assetId
    this.addressOf(app.id).value = app.address
    this.creatorOf(app.id).value = app.creator
  }

  /**
   * Seed the campaign escrow with the Claim ASA's entire supply, once.
   *
   * Called after the campaign has recorded the asset via `attachClaimAsa` (which opts the escrow in). The campaign mints claim units
   * from this holding on pledge — the vault is never on the per-pledge path.
   *
   * @param app The campaign application.
   */
  @abimethod()
  seedSupply(app: Application): void {
    const assetId = this.asaOf(app.id).get({ default: Uint64(0) })
    assert(assetId !== Uint64(0), 'unknown campaign')

    // The whole supply must still be here: the seed is a one-shot.
    const held: uint64 = op.AssetHolding.assetBalance(Global.currentApplicationAddress, Asset(assetId))[0]
    assert(held === TOTAL_CLAIM_UNITS, 'supply already seeded')

    /* v8 ignore next 8 — the seed only runs while the whole supply sits at the vault; the offline ledger can't emulate the vault's own
     * asset holding, so this transfer is covered by the LocalNet integration tests (contract.integration.test.ts). */
    itxn
      .assetTransfer({
        xferAsset: assetId,
        assetReceiver: app.address,
        assetAmount: TOTAL_CLAIM_UNITS,
        fee: Uint64(0),
      })
      .submit()
  }

  /**
   * Pay a backer (a cancellation or refund), driven by the campaign app.
   *
   * Only the campaign's own app account may call — the campaign program (hash-verified, non-updatable) has already validated the
   * surrender transfer before invoking this. The vault pays the given amount from the pooled balance.
   *
   * @param app The campaign application.
   * @param backer The backer to pay.
   * @param amount The amount in microAlgos (equals the surrendered claim units).
   */
  @abimethod()
  payBack(app: Application, backer: Account, amount: uint64): void {
    this.assertCampaignCaller(app)
    assert(amount > 0, 'amount must be greater than zero')

    itxn
      .payment({
        receiver: backer,
        amount: amount,
        fee: Uint64(0),
      })
      .submit()
  }

  /**
   * Pay the campaign's creator on a successful claim, driven by the campaign app.
   *
   * The payout is **derived from unit conservation**, not trusted: outstanding claims = total − vault holding − campaign holding, which
   * equals the live pledge total at claim time. The settlement is recorded here so refunds are rejected afterwards and the campaign can
   * be garbage-collected.
   *
   * @param app The campaign application.
   */
  @abimethod()
  payClaim(app: Application): void {
    this.assertCampaignCaller(app)
    assert(this.settled(app.id).get({ default: Uint64(0) }) === Uint64(0), 'already settled')

    const assetId = this.asaOf(app.id).get({ default: Uint64(0) })
    const vaultHeld: uint64 = op.AssetHolding.assetBalance(Global.currentApplicationAddress, Asset(assetId))[0]
    const campaignHeld: uint64 = op.AssetHolding.assetBalance(Txn.sender, Asset(assetId))[0]
    const amount: uint64 = TOTAL_CLAIM_UNITS - vaultHeld - campaignHeld
    assert(amount > 0, 'nothing to claim')

    this.settled(app.id).value = STATUS_CLAIMED

    itxn
      .payment({
        receiver: this.creatorOf(app.id).value,
        amount: amount,
        fee: Uint64(0),
      })
      .submit()
  }

  /**
   * Record a failed campaign's settlement, driven by the campaign app during `delete()`.
   *
   * Once settled as failed, refunds are served directly by the vault (`refund(axfer)`) and keep working forever, even after the campaign
   * application is deleted.
   *
   * @param app The campaign application.
   */
  @abimethod()
  settle(app: Application): void {
    this.assertCampaignCaller(app)
    assert(this.settled(app.id).get({ default: Uint64(0) }) === Uint64(0), 'already settled')

    this.settled(app.id).value = STATUS_FAILED
  }

  /**
   * Refund a backer of a failed campaign, directly — works indefinitely, including after the campaign app has been deleted.
   *
   * The backer surrenders claim units to the vault in the same group and receives the same amount of microAlgos. The campaign id is
   * caller-supplied but verified against the vault's own asset mapping, and only settled-failed campaigns pay.
   *
   * @param app The settled-failed campaign application.
   * @param axfer Asset transfer of the campaign's Claim ASA from the caller to the vault.
   */
  @abimethod()
  refund(app: Application, axfer: gtxn.AssetTransferTxn): void {
    assert(axfer.sender === Txn.sender, 'claim units must come from the caller')
    assert(axfer.assetReceiver === Global.currentApplicationAddress, 'claim units must go to the vault')
    assert(axfer.assetAmount > 0, 'claim amount must be greater than zero')
    assert(
      axfer.assetCloseTo === Account(Bytes.fromHex('0000000000000000000000000000000000000000000000000000000000000000')),
      'close-out is not allowed here',
    )

    // The campaign is caller-supplied but verified against the vault's own asset mapping: a wrong id can never redirect a payout.
    assert(this.asaOf(app.id).get({ default: Uint64(0) }) === axfer.xferAsset.id, 'unknown claim asset')
    assert(this.settled(app.id).get({ default: Uint64(0) }) === STATUS_FAILED, 'campaign is not refundable')

    itxn
      .payment({
        receiver: Txn.sender,
        amount: axfer.assetAmount,
        fee: Uint64(0),
      })
      .submit()
  }

  /**
   * Garbage-collect a claimed campaign's worthless claim units: claw a named holder's whole balance back to the vault.
   *
   * Permissionless, only for settled-claimed campaigns (their units are provably worthless), never for open or failed campaigns. Called
   * one holder at a time; entirely optional and off any critical path — it exists so a campaign's Claim ASA can eventually be destroyed
   * and the vault's parked minimum balance recovered.
   *
   * @param app The claimed campaign application.
   * @param holder The account to claw back.
   */
  @abimethod()
  sweepClaimAsa(app: Application, holder: Account): void {
    assert(this.settled(app.id).get({ default: Uint64(0) }) === STATUS_CLAIMED, 'campaign not claimed')

    const assetId = this.asaOf(app.id).get({ default: Uint64(0) })
    const balance = op.AssetHolding.assetBalance(holder, Asset(assetId))[0]

    /* v8 ignore next 9 — the claw only runs when the holder has a balance; the offline ledger can't emulate opted-in holdings, so
     * this transfer is covered by the LocalNet integration tests (contract.integration.test.ts). */
    if (balance > 0) {
      itxn
        .assetTransfer({
          xferAsset: assetId,
          assetSender: holder,
          assetReceiver: Global.currentApplicationAddress,
          assetAmount: balance,
          fee: Uint64(0),
        })
        .submit()
    }
  }

  /**
   * Destroy a settled campaign's Claim ASA once the vault again holds the entire supply, freeing the vault's parked minimum balance.
   *
   * @param app The settled campaign application.
   */
  @abimethod()
  destroyClaimAsa(app: Application): void {
    assert(this.settled(app.id).exists, 'campaign not settled')

    const assetId = this.asaOf(app.id).get({ default: Uint64(0) })
    const held = op.AssetHolding.assetBalance(Global.currentApplicationAddress, Asset(assetId))[0]
    assert(held === TOTAL_CLAIM_UNITS, 'claim units outstanding')

    /* v8 ignore next 11 — the destroy + box cleanup only run when the vault holds the whole supply; the offline ledger can't emulate
     * the vault's own asset holding, so this path is covered by the LocalNet integration tests (contract.integration.test.ts). */
    itxn
      .assetConfig({
        configAsset: assetId,
        fee: Uint64(0),
      })
      .submit()

    this.settled(app.id).delete()
    this.asaOf(app.id).delete()
    this.addressOf(app.id).delete()
    this.creatorOf(app.id).delete()
  }

  /**
   * The caller of `payBack`/`payClaim`/`settle` must be the campaign app's own account (matched via the mapping recorded at issuance).
   *
   * @param app The campaign application.
   */
  private assertCampaignCaller(app: Application): void {
    assert(this.asaOf(app.id).get({ default: Uint64(0) }) !== Uint64(0), 'unknown campaign')
    assert(this.addressOf(app.id).value === Txn.sender, 'not the campaign app')
  }
}
