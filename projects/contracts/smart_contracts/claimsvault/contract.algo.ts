import type { Account, Application, bytes, uint64 } from '@algorandfoundation/algorand-typescript'
import {
  BoxMap,
  Bytes,
  Contract,
  Global,
  GlobalState,
  OpUpFeeSource,
  TransactionType,
  Txn,
  Uint64,
  abimethod,
  assert,
  ensureBudget,
  gtxn,
  itxn,
  op,
  urange,
} from '@algorandfoundation/algorand-typescript'

/**
 * ClaimsVault — the permanent, pooled refund escrow for AlgorArt campaigns (claim-tree design, see
 * docs/claim-tree-protocol.md).
 *
 * The vault separates **backers' pledged ALGO** from campaign apps: pledges are paid to the vault and recorded per
 * campaign with `credit()`, and the vault alone pays out cancellations, refunds, and successful claims. There is no
 * Claim ASA and no per-backer on-chain state anywhere — a backer's receipt is their pledge leaf in the campaign's
 * frontier-Merkle tree, and refunds null the leaf in place (see the campaign contract).
 *
 * The vault holds all campaigns' funds in one pooled account. Cross-campaign isolation is enforced by per-campaign
 * balance guards: every method that pays out asserts `amount ≤ paidIn − paidOut` for that campaign's box, so a bug (or
 * a malicious campaign program, which cannot exist — campaigns are hash-verified at Factory registration and
 * non-updatable) in one campaign can never drain another's funds.
 *
 * Trust model: `payBack`, `payClaim`, `settle`, and `notifyDelete` are reachable only as inner app calls from the
 * campaign's own app account (`Txn.sender == app.address` — unforgeable, and app addresses are distinct per app id).
 * `credit`, `settleOpen`, `refund`, and `finalize` are permissionless top-level calls whose every effect is verified
 * against the vault's own boxes and the caller's group.
 */

// Vault box statuses (1 byte in the packed box): 1 = Open, 2 = Failed, 3 = Claimed.
const BOX_OPEN = Bytes.fromHex('01')
const BOX_FAILED = Bytes.fromHex('02')
const BOX_CLAIMED = Bytes.fromHex('03')

// Packed vault box layout (65 bytes): paidIn[0:8] ‖ paidOut[8:16] ‖ root[16:48] ‖ n[48:56] ‖ status[56:57] ‖ settledAt[57:65].

// ARC-4 method selector for the Factory's `isRegistered(uint64)bool` readonly method (the Factory is unchanged by the
// claim-tree rewrite, so this selector is unchanged — verified on-chain via an inner call before a campaign's first box
// is created, so an unregistered campaign can never park the vault's minimum balance).
const FACTORY_IS_REGISTERED_SELECTOR = Bytes.fromHex('716a3d0e')

// The ARC-4 bool return of the Factory's `isRegistered`: the return-value prefix (0x151f7c75) followed by 0x80 (true).
const FACTORY_REGISTERED_TRUE = Bytes.fromHex('151f7c7580')

export class ClaimsVault extends Contract {
  /** The Factory registry app; its `registered` boxes are the canonical campaign records. */
  factory = GlobalState<Application>()

  /** Where `finalize()` sweeps a failed campaign's residual after the refund window; fixed at creation. */
  sweepTarget = GlobalState<Account>()

  /** Refund window in seconds after settlement; fixed at creation. */
  refundWindow = GlobalState<uint64>()

  /** Campaign app id → packed box (paidIn ‖ paidOut ‖ root ‖ n ‖ status ‖ settledAt); absent until first `credit`. */
  campaignBox = BoxMap<uint64, bytes>({ keyPrefix: 'c' })

  /**
   * Deploy the vault.
   *
   * The platform funds the vault's application account after creation (the account base plus headroom: each campaign's
   * first `credit` parks a 32,100 µA box on the vault, recovered by `notifyDelete`/`finalize`).
   *
   * @param factory The Factory registry app.
   * @param target Where `finalize()` sweeps failed campaigns' residuals after the refund window.
   * @param window Refund window in seconds after settlement.
   */
  @abimethod({ onCreate: 'require' })
  create(factory: Application, target: Account, window: uint64): void {
    assert(Txn.applicationId.id === 0, 'must be called on app creation')
    assert(window > Uint64(0), 'refund window must be positive')

    this.factory.value = factory
    this.sweepTarget.value = target
    this.refundWindow.value = window
  }

  /**
   * Record one pledge payment into a campaign's box.
   *
   * Permissionless top-level call, normally grouped as `[Payment, Campaign.pledge, Vault.credit]`. The payment is
   * **independently verified**: the vault scans its own group for a payment from the caller to the vault for `amount`
   * (no pledge-presence check is needed — a `credit` without a matching `pledge`, or vice versa, strands only the
   * deviator's own funds under the per-campaign balance guard). On first touch the campaign must be Factory-registered.
   *
   * @param app The campaign application.
   * @param amount The pledged amount, in microAlgos.
   */
  @abimethod()
  credit(app: Application, amount: uint64): void {
    assert(amount > Uint64(0), 'pledge must be greater than zero')

    const existing = this.campaignBox(app.id).get({ default: Bytes() })
    if (existing.length !== Uint64(0)) {
      assert(existing.slice(56, 57) === BOX_OPEN, 'campaign is not open')
    }

    // Independent payment verification: scan the caller's own group (fully visible because `credit` is top-level) for
    // the payment. Only transactions before this call are considered.
    let found = false
    for (const i of urange(Txn.groupIndex)) {
      const candidate = gtxn.Transaction(i)
      if (candidate.type === TransactionType.Payment) {
        const payment = gtxn.PaymentTxn(i)
        if (payment.sender === Txn.sender && payment.receiver === Global.currentApplicationAddress && payment.amount === amount) {
          found = true
        }
      }
    }
    assert(found, 'matching payment not found in group')

    if (existing.length === Uint64(0)) {
      this.checkRegistration(app)
      /* v8 ignore next — see checkRegistration; covered on LocalNet. */
      this.createBox(app.id, amount)
    } else {
      const paidIn: uint64 = op.btoi(existing.slice(0, 8))
      this.campaignBox(app.id).value = this.packBox(
        paidIn + amount,
        op.btoi(existing.slice(8, 16)),
        existing.slice(16, 48),
        op.btoi(existing.slice(48, 56)),
        BOX_OPEN,
        op.btoi(existing.slice(57, 65)),
      )
    }
  }

  /**
   * Verify a first-touch campaign against the Factory registry via an inner call (its log carries the readonly
   * answer), so an unregistered campaign can never park the vault's minimum balance.
   *
   * @param app The campaign application.
   */
  /* v8 ignore next — the offline ledger executes the inner call but cannot emulate its log; the registration gate is
   * covered by the LocalNet integration tests (contract.integration.test.ts). */
  private checkRegistration(app: Application): void {
    const registrationCheck = itxn
      .applicationCall({
        appId: this.factory.value,
        appArgs: [FACTORY_IS_REGISTERED_SELECTOR, op.itob(app.id)],
        fee: Uint64(0),
      })
      .submit()
    assert(registrationCheck.lastLog === FACTORY_REGISTERED_TRUE, 'campaign not registered')
  }

  /**
   * Create a campaign's box on first touch (paid-in inflow, zeroed tree fields, Open).
   *
   * @param appId The campaign application id.
   * @param amount The first verified inflow, in microAlgos.
   */
  /* v8 ignore next — reachable only for registered campaigns (see checkRegistration); covered on LocalNet. */
  private createBox(appId: uint64, amount: uint64): void {
    this.campaignBox(appId).value = this.packBox(amount, Uint64(0), this.zeroRoot(), Uint64(0), BOX_OPEN, Uint64(0))
  }

  /**
   * Pay a backer (a cancellation or a campaign-driven refund), driven by the campaign app.
   *
   * Only the campaign's own app account may call. The per-campaign balance guard caps the payout at verified inflows.
   *
   * @param app The campaign application.
   * @param backer The backer to pay.
   * @param amount The amount to pay, in microAlgos.
   */
  @abimethod()
  payBack(app: Application, backer: Account, amount: uint64): void {
    this.assertCampaignCaller(app)
    assert(amount > Uint64(0), 'nothing to pay back')

    const box = this.readBox(app.id)
    assert(box.slice(56, 57) === BOX_OPEN, 'campaign is not open')
    const paidIn: uint64 = op.btoi(box.slice(0, 8))
    const paidOut: uint64 = op.btoi(box.slice(8, 16))
    assert(amount <= paidIn - paidOut, 'insufficient campaign balance')

    this.campaignBox(app.id).value = this.packBox(
      paidIn,
      paidOut + amount,
      box.slice(16, 48),
      op.btoi(box.slice(48, 56)),
      BOX_OPEN,
      op.btoi(box.slice(57, 65)),
    )

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
   * The payout is **derived, not trusted**: `paidIn − paidOut` equals the live pledge total (cancels were balanced), so
   * no caller-supplied figure is involved. The box flips to Claimed, rejecting all later refunds.
   *
   * @param app The campaign application.
   */
  @abimethod()
  payClaim(app: Application): void {
    this.assertCampaignCaller(app)

    const box = this.readBox(app.id)
    assert(box.slice(56, 57) === BOX_OPEN, 'campaign is not open')
    const paidIn: uint64 = op.btoi(box.slice(0, 8))
    const paidOut: uint64 = op.btoi(box.slice(8, 16))
    const payout: uint64 = paidIn - paidOut
    assert(payout > Uint64(0), 'nothing to claim')

    this.campaignBox(app.id).value = this.packBox(
      paidIn,
      paidOut + payout,
      box.slice(16, 48),
      op.btoi(box.slice(48, 56)),
      BOX_CLAIMED,
      op.btoi(box.slice(57, 65)),
    )

    itxn
      .payment({
        receiver: app.creator,
        amount: payout,
        fee: Uint64(0),
      })
      .submit()
  }

  /**
   * Record a failed campaign's settlement, driven by the campaign app during `delete()`.
   *
   * Writes the campaign's final root/N into the box (backers' proofs verify against it after the campaign is gone) and
   * flips an Open box to Failed; already-Failed is a no-op, and a missing box is a no-op too (a pristine campaign with
   * no box — including one with a stray no-pledge inflow — deletes cleanly, and the stray case becomes finalizable).
   * After this, campaign-driven `payBack` is rejected and all refunds flow through `refund()`.
   *
   * @param app The campaign application.
   * @param root The campaign's final tree root.
   * @param n The campaign's final position count.
   */
  @abimethod()
  settle(app: Application, root: bytes, n: uint64): void {
    if (!this.campaignBox(app.id).exists) {
      return
    }
    this.assertCampaignCaller(app)
    assert(root.length === Uint64(32), 'bad root length')

    const box = this.readBox(app.id)
    const status = box.slice(56, 57)
    if (status === BOX_OPEN) {
      this.campaignBox(app.id).value = this.packBox(
        op.btoi(box.slice(0, 8)),
        op.btoi(box.slice(8, 16)),
        root,
        n,
        BOX_FAILED,
        Global.latestTimestamp,
      )
    } else {
      assert(status === BOX_FAILED, 'already claimed')
    }
  }

  /**
   * Settle a failed campaign permissionlessly (the "creator vanished" case), reading the still-existing campaign app.
   *
   * After this, campaign-driven `payBack` is rejected (box not Open) and all refunds flow through `refund()`.
   *
   * @param app The failed campaign application.
   */
  @abimethod()
  settleOpen(app: Application): void {
    const box = this.readBox(app.id)
    assert(box.slice(56, 57) === BOX_OPEN, 'campaign is not open')

    // The campaign app still exists here, so its global state is readable (this is never attempted after deletion).
    /* v8 ignore start — every created campaign writes all six globals, so the missing-key branches are defensive only;
     * the guards below (claimed/deadline/goal) run offline and the whole path runs on LocalNet. */
    const statusState = op.AppGlobal.getExUint64(app, Bytes('status'))
    const raisedState = op.AppGlobal.getExUint64(app, Bytes('raised'))
    const goalState = op.AppGlobal.getExUint64(app, Bytes('goal'))
    const deadlineState = op.AppGlobal.getExUint64(app, Bytes('deadline'))
    const rootState = op.AppGlobal.getExBytes(app, Bytes('root'))
    const nState = op.AppGlobal.getExUint64(app, Bytes('n'))
    assert(statusState[1] && raisedState[1] && goalState[1] && deadlineState[1] && rootState[1] && nState[1], 'campaign state missing')
    /* v8 ignore stop */
    assert(statusState[0] !== Uint64(2), 'campaign already claimed')
    assert(Global.latestTimestamp >= deadlineState[0], 'deadline has not passed')
    assert(raisedState[0] < goalState[0], 'goal was reached')

    this.campaignBox(app.id).value = this.packBox(
      op.btoi(box.slice(0, 8)),
      op.btoi(box.slice(8, 16)),
      rootState[0],
      nState[0],
      BOX_FAILED,
      Global.latestTimestamp,
    )
  }

  /**
   * Refund one pledge of a settled-failed campaign, directly — works after the campaign app has been deleted.
   *
   * Permissionless: the leaf is rebuilt from the caller + proof (never trusted) and verified against the box's stored
   * root; a second refund of the same position — or a proof built against any older root — reconstructs a non-stored
   * root and is rejected. Runs entirely from vault-local state. Only within the refund window.
   *
   * @param app The settled-failed campaign application.
   * @param k Leaf position to null.
   * @param amount Pledged amount committed by the leaf.
   * @param txid The pledge payment's transaction ID, committed in the leaf at pledge time.
   * @param path The auth path as one blob: siblings (32·r) ‖ top (32·e) ‖ lower (32·c).
   */
  @abimethod()
  refund(app: Application, k: uint64, amount: uint64, txid: bytes, path: bytes): void {
    assert(amount > Uint64(0), 'refund must be greater than zero')
    assert(txid.length === Uint64(32), 'bad txid length')

    const box = this.readBox(app.id)
    assert(box.slice(56, 57) === BOX_FAILED, 'campaign is not refundable')
    const paidIn: uint64 = op.btoi(box.slice(0, 8))
    const paidOut: uint64 = op.btoi(box.slice(8, 16))
    const n: uint64 = op.btoi(box.slice(48, 56))
    const settledAt: uint64 = op.btoi(box.slice(57, 65))
    assert(Global.latestTimestamp <= settledAt + this.refundWindow.value, 'refund window closed')
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

    const leaf = op.sha512_256(Bytes.fromHex('01').concat(Txn.sender.bytes).concat(op.itob(amount)).concat(txid))
    assert(this.combineBlob(leaf, k, path, r, c, hasTop) === box.slice(16, 48), 'proof does not match root')
    assert(amount <= paidIn - paidOut, 'insufficient campaign balance')

    this.campaignBox(app.id).value = this.packBox(
      paidIn,
      paidOut + amount,
      this.combineBlob(this.zeroRoot(), k, path, r, c, hasTop),
      n,
      BOX_FAILED,
      settledAt,
    )

    itxn
      .payment({
        receiver: Txn.sender,
        amount: amount,
        fee: Uint64(0),
      })
      .submit()
  }

  /**
   * Release a claimed campaign's box, driven by the campaign app during `delete()`.
   *
   * Requires the box Claimed with inflows fully paid out — O(1), and the vault parks nothing for successful campaigns.
   *
   * @param app The campaign application.
   */
  @abimethod()
  notifyDelete(app: Application): void {
    this.assertCampaignCaller(app)

    const box = this.readBox(app.id)
    assert(box.slice(56, 57) === BOX_CLAIMED, 'campaign not claimed')
    assert(op.btoi(box.slice(0, 8)) === op.btoi(box.slice(8, 16)), 'campaign balance outstanding')

    this.campaignBox(app.id).delete()
  }

  /**
   * Sweep a settled-failed campaign's residual to the sweep target and release its box, once the refund window closes.
   *
   * Permissionless, O(1). Unclaimed refunds after a generous window fund the sweep target (disclosed at pledge time);
   * backer-controlled refunds need no platform action before the window closes.
   *
   * @param app The settled-failed campaign application.
   */
  @abimethod()
  finalize(app: Application): void {
    const box = this.readBox(app.id)
    assert(box.slice(56, 57) === BOX_FAILED, 'campaign is not failed')
    const settledAt: uint64 = op.btoi(box.slice(57, 65))
    assert(Global.latestTimestamp >= settledAt + this.refundWindow.value, 'refund window still open')

    const residual: uint64 = op.btoi(box.slice(0, 8)) - op.btoi(box.slice(8, 16))
    if (residual > Uint64(0)) {
      itxn
        .payment({
          receiver: this.sweepTarget.value,
          amount: residual,
          fee: Uint64(0),
        })
        .submit()
    }

    this.campaignBox(app.id).delete()
  }

  /**
   * The caller of the campaign-driven methods must be the campaign app's own account (matched by app address —
   * unforgeable, and app addresses are distinct per app id), and its box must exist.
   *
   * @param app The campaign application.
   */
  private assertCampaignCaller(app: Application): void {
    assert(this.campaignBox(app.id).exists, 'unknown campaign')
    assert(Txn.sender === app.address, 'not the campaign app')
  }

  /**
   * Read a campaign's packed box, asserting it exists.
   *
   * @param appId The campaign application id.
   * @returns The 65-byte packed box.
   */
  private readBox(appId: uint64): bytes {
    const box = this.campaignBox(appId).get({ default: Bytes() })
    assert(box.length === Uint64(65), 'unknown campaign')
    return box
  }

  /**
   * Pack the vault box fields into the 65-byte value.
   *
   * @param paidIn Verified inflows, in microAlgos.
   * @param paidOut Outflows paid, in microAlgos.
   * @param root Tree root (or Z before settlement).
   * @param n Position count (0 before settlement).
   * @param status One status byte.
   * @param settledAt Settlement timestamp (0 before settlement).
   * @returns The packed box value.
   */
  private packBox(paidIn: uint64, paidOut: uint64, root: bytes, n: uint64, status: bytes, settledAt: uint64): bytes {
    return op.itob(paidIn).concat(op.itob(paidOut)).concat(root).concat(op.itob(n)).concat(status).concat(op.itob(settledAt))
  }

  /**
   * The consumed-leaf marker: 32 zero bytes.
   *
   * @returns Z.
   */
  private zeroRoot(): bytes {
    return Bytes.fromHex('0000000000000000000000000000000000000000000000000000000000000000')
  }

  /**
   * Hash two child nodes into their parent (SHA-512/256 — the AVM `sha512_256` opcode, *not* `sha256`).
   *
   * @param left Left child.
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
   * Count the set bits of N. Exits at the highest set bit, so the cost is O(log N), not O(64).
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
    /* v8 ignore next — reachable only for N = 2^64 − 1 (no early exit in 64 iterations); defensive cap. */
    return count
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
    /* v8 ignore next — reachable only for trees of depth 64 (no missing level); defensive cap. */
    return r
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
