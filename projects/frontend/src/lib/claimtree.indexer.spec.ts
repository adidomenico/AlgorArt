import { encodeAddress } from 'algosdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchMyLeaves, fetchPledges, fetchSpends, loadTree } from './claimtree'

const indexerMock = vi.hoisted(() => ({
  searchForTransactions: vi.fn(),
  lookupBlock: vi.fn(),
}))

vi.mock('./algorand', () => ({
  indexer: indexerMock,
}))

const VAULT = encodeAddress(new Uint8Array(32).fill(9))
const BACKER_A = encodeAddress(new Uint8Array(32).fill(1))
const BACKER_B = encodeAddress(new Uint8Array(32).fill(2))
const CAMPAIGN = 42n
const VAULT_ID = 7n

const SELECTOR = {
  pledge: 'a4030bd2',
  cancel: '457e292e',
  refund: '4b1a1d96',
  claim: 'f1577726',
  vaultRefund: '0fe03dd2',
  credit: 'deadbeef',
} as const

function selectorBytes(selector: string): Uint8Array {
  return Buffer.from(selector, 'hex')
}

function u64(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  let v = value
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/**
 * Minimal app-call fixture: only the fields the fetcher reads.
 *
 * @param txid Base32 transaction id.
 * @param sender Sender address.
 * @param round Confirmed round.
 * @param args Application args (selector first).
 * @returns The fixture transaction.
 */
function appCall(txid: string, sender: string, round: bigint, args: Uint8Array[]): unknown {
  return { id: txid, sender, confirmedRound: round, applicationTransaction: { applicationId: 0n, applicationArgs: args } }
}

function pledgeCall(txid: string, sender: string, round: bigint): unknown {
  return appCall(txid, sender, round, [selectorBytes(SELECTOR.pledge), new Uint8Array()])
}

function spendCall(txid: string, sender: string, round: bigint, selector: string, k: bigint): unknown {
  return appCall(txid, sender, round, [selectorBytes(selector), u64(k)])
}

function vaultRefundCall(txid: string, sender: string, round: bigint, appId: bigint, k: bigint): unknown {
  return {
    id: txid,
    sender,
    confirmedRound: round,
    applicationTransaction: { applicationId: VAULT_ID, applicationArgs: [selectorBytes(SELECTOR.vaultRefund), u64(appId), u64(k)] },
  }
}

/**
 * Minimal payment fixture.
 *
 * @param txid Base32 transaction id.
 * @param sender Sender address.
 * @param receiver Receiver address.
 * @param amount Amount in microAlgos.
 * @returns The fixture transaction.
 */
function payment(txid: string, sender: string, receiver: string, amount: bigint): unknown {
  return { id: txid, sender, paymentTransaction: { amount, receiver } }
}

/**
 * Paginated search mock keyed by application id.
 *
 * @param pagesByApp Result pages per application id.
 * @returns A `searchForTransactions` mock implementation.
 */
function searchMock(pagesByApp: Map<bigint, unknown[][]>) {
  return () => {
    let appId = 0n
    let token: string | undefined
    const builder = {
      applicationID: (id: number | bigint) => {
        appId = BigInt(id)
        return builder
      },
      limit: () => builder,
      nextToken: (next: string) => {
        token = next
        return builder
      },
      do: () => {
        const pages = pagesByApp.get(appId) ?? [[]]
        const index = token === undefined ? 0 : Number(token)
        const transactions = pages[index] ?? []
        const nextToken = index + 1 < pages.length ? String(index + 1) : undefined
        return Promise.resolve({ transactions, nextToken, currentRound: 0n })
      },
    }
    return builder
  }
}

function blockMock(blocks: Map<bigint, unknown[]>) {
  return (round: number | bigint) => ({
    do: () => Promise.resolve({ transactions: blocks.get(BigInt(round)) ?? [] }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('fetchPledges', () => {
  it('pairs each pledge with its group payment across rounds, in chain order', async () => {
    // Block 100 exercises every scan-skip branch before the match: wrong sender, app call (no payment fields),
    // wrong receiver, zero amount, and a full match without id.
    const decoySender = payment('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', BACKER_B, VAULT, 9n)
    const decoyApp = appCall('TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT', BACKER_A, 100n, [selectorBytes(SELECTOR.claim)])
    const decoyReceiver = {
      id: 'UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU',
      sender: BACKER_A,
      paymentTransaction: { amount: 9n, receiver: BACKER_B },
    }
    const decoyZero = {
      id: 'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
      sender: BACKER_A,
      paymentTransaction: { amount: 0n, receiver: VAULT },
    }
    const decoyNoId = { sender: BACKER_A, paymentTransaction: { amount: 9n, receiver: VAULT } }
    const payA = payment('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', BACKER_A, VAULT, 3_000_000n)
    const callA = pledgeCall('MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM', BACKER_A, 100n)
    const payB = payment('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', BACKER_B, VAULT, 1_000_000n)
    const callB = pledgeCall('NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN', BACKER_B, 100n)
    const payC = payment('CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', BACKER_A, VAULT, 2_000_000n)
    const callC = pledgeCall('OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO', BACKER_A, 101n)
    const payD = payment('DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', BACKER_B, VAULT, 4_000_000n)
    const callD = pledgeCall('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', BACKER_B, 102n)
    const noRoundCall = {
      sender: BACKER_A,
      applicationTransaction: { applicationArgs: [selectorBytes(SELECTOR.pledge)] },
    }
    const noArgsCall = {
      id: 'HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH',
      sender: BACKER_A,
      confirmedRound: 100n,
    }
    indexerMock.searchForTransactions.mockImplementation(
      searchMock(
        new Map([
          [
            CAMPAIGN,
            [
              [callC, callD],
              [callA, callB, noRoundCall, noArgsCall],
            ],
          ],
        ]),
      ),
    )
    indexerMock.lookupBlock.mockImplementation(
      blockMock(
        new Map([
          // Scan skips (examined backwards from callA): id-less full match, zero amount, wrong receiver, app call
          // without payment fields, wrong sender — then the real payment. (On-chain groups are contiguous; the
          // interleaving here only exercises the skip branches.)
          [100n, [payA, decoySender, decoyApp, decoyReceiver, decoyZero, decoyNoId, callA, payB, callB]],
          [101n, [payC, callC]],
          [102n, [payD, callD]],
        ]),
      ),
    )

    const pledges = await fetchPledges(CAMPAIGN, VAULT)
    expect(pledges.map((p) => [p.backer, p.amount, p.txidHex, p.round])).toEqual([
      [BACKER_A, 3_000_000n, expect.any(String), 100n],
      [BACKER_B, 1_000_000n, expect.any(String), 100n],
      [BACKER_A, 2_000_000n, expect.any(String), 101n],
      [BACKER_B, 4_000_000n, expect.any(String), 102n],
    ])
    // TxIDs come from the paired payments (base32 → hex), not from the app calls.
    expect(pledges[0]?.txidHex).not.toEqual(pledges[2]?.txidHex)
  })

  it('ignores non-pledge calls', async () => {
    const claim = appCall('ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ', BACKER_A, 100n, [selectorBytes(SELECTOR.claim)])
    indexerMock.searchForTransactions.mockImplementation(searchMock(new Map([[CAMPAIGN, [[claim]]]])))
    indexerMock.lookupBlock.mockImplementation(blockMock(new Map([[100n, [claim]]])))

    expect(await fetchPledges(CAMPAIGN, VAULT)).toEqual([])
  })

  it('throws when a pledge has no pairable payment', async () => {
    const callA = pledgeCall('MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM', BACKER_A, 100n)
    indexerMock.searchForTransactions.mockImplementation(searchMock(new Map([[CAMPAIGN, [[callA]]]])))
    indexerMock.lookupBlock.mockImplementation(
      blockMock(new Map([[100n, [{ sender: BACKER_B, paymentTransaction: { amount: 9n, receiver: VAULT } }, callA]]])),
    )

    await expect(fetchPledges(CAMPAIGN, VAULT)).rejects.toThrow(/no paired payment/)
  })

  it('throws when a call has no id to locate with', async () => {
    const callA = pledgeCall('MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM', BACKER_A, 100n)
    const payA = payment('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', BACKER_A, VAULT, 3_000_000n)
    const noIdCall = {
      sender: BACKER_A,
      confirmedRound: 100n,
      applicationTransaction: { applicationArgs: [selectorBytes(SELECTOR.pledge)] },
    }
    indexerMock.searchForTransactions.mockImplementation(searchMock(new Map([[CAMPAIGN, [[callA, noIdCall]]]])))
    indexerMock.lookupBlock.mockImplementation(blockMock(new Map([[100n, [payA, callA]]])))

    await expect(fetchPledges(CAMPAIGN, VAULT)).rejects.toThrow(/not found in its round block/)
  })

  it('throws when a pledge call is missing from its round block', async () => {
    const callA = pledgeCall('MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM', BACKER_A, 100n)
    indexerMock.searchForTransactions.mockImplementation(searchMock(new Map([[CAMPAIGN, [[callA]]]])))
    // Block response without a transactions key (torn read): treated as empty, so the call is missing.
    indexerMock.lookupBlock.mockImplementation(() => ({
      do: () => Promise.resolve({}),
    }))

    await expect(fetchPledges(CAMPAIGN, VAULT)).rejects.toThrow(/not found in its round block/)
  })
})

describe('fetchSpends', () => {
  it('collects campaign and vault spends for this campaign only', async () => {
    const cancel = spendCall('PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP', BACKER_A, 100n, SELECTOR.cancel, 2n)
    const refund = spendCall('QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ', BACKER_B, 101n, SELECTOR.refund, 0n)
    const shortCancel = appCall('IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII', BACKER_A, 100n, [selectorBytes(SELECTOR.cancel)])
    const vaultOurs = vaultRefundCall('RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR', BACKER_A, 102n, CAMPAIGN, 1n)
    const vaultTheirs = vaultRefundCall('SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS', BACKER_A, 102n, 999n, 5n)
    const vaultShort = appCall('JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ', BACKER_A, 102n, [
      selectorBytes(SELECTOR.vaultRefund),
    ])
    const credit = appCall('TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT', BACKER_A, 100n, [selectorBytes(SELECTOR.credit)])
    indexerMock.searchForTransactions.mockImplementation(
      searchMock(
        new Map([
          [CAMPAIGN, [[cancel, refund, shortCancel]]],
          [VAULT_ID, [[vaultOurs, vaultTheirs, vaultShort, credit]]],
        ]),
      ),
    )

    expect(await fetchSpends(CAMPAIGN, VAULT_ID)).toEqual([{ position: 2 }, { position: 0 }, { position: 1 }])
  })
})

describe('fetchMyLeaves', () => {
  it('returns only the viewer’s live leaves', async () => {
    const payA = payment('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', BACKER_A, VAULT, 3_000_000n)
    const callA = pledgeCall('MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM', BACKER_A, 100n)
    const payB = payment('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', BACKER_B, VAULT, 1_000_000n)
    const callB = pledgeCall('NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN', BACKER_B, 100n)
    const cancel = spendCall('PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP', BACKER_A, 101n, SELECTOR.cancel, 0n)
    indexerMock.searchForTransactions.mockImplementation(
      searchMock(
        new Map([
          [CAMPAIGN, [[callA, callB, cancel]]],
          [VAULT_ID, [[]]],
        ]),
      ),
    )
    indexerMock.lookupBlock.mockImplementation(blockMock(new Map([[100n, [payA, callA, payB, callB]]])))

    const leaves = await fetchMyLeaves(CAMPAIGN, VAULT_ID, VAULT, BACKER_A)
    expect(leaves).toEqual([])
    const leavesB = await fetchMyLeaves(CAMPAIGN, VAULT_ID, VAULT, BACKER_B)
    expect(leavesB.map((leaf) => [leaf.position, leaf.amount])).toEqual([[1, 1_000_000n]])
  })
})

describe('loadTree', () => {
  it('replays pledges in order then nulls spends', async () => {
    const payA = payment('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', BACKER_A, VAULT, 3_000_000n)
    const callA = pledgeCall('MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM', BACKER_A, 100n)
    const payB = payment('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', BACKER_B, VAULT, 1_000_000n)
    const callB = pledgeCall('NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN', BACKER_B, 101n)
    const cancel = spendCall('PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP', BACKER_A, 102n, SELECTOR.cancel, 0n)
    indexerMock.searchForTransactions.mockImplementation(
      searchMock(
        new Map([
          [CAMPAIGN, [[callA], [callB, cancel]]],
          [VAULT_ID, [[]]],
        ]),
      ),
    )
    indexerMock.lookupBlock.mockImplementation(
      blockMock(
        new Map([
          [100n, [payA, callA]],
          [101n, [payB, callB]],
        ]),
      ),
    )

    const tree = await loadTree(CAMPAIGN, VAULT_ID, VAULT)
    expect(tree.leaves.length).toEqual(2)
    expect(tree.raised).toEqual(1_000_000n)
  })

  it('rejects a spend for a position that was never pledged', async () => {
    const ghost = spendCall('GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG', BACKER_A, 100n, SELECTOR.cancel, 5n)
    indexerMock.searchForTransactions.mockImplementation(
      searchMock(
        new Map([
          [CAMPAIGN, [[ghost]]],
          [VAULT_ID, [[]]],
        ]),
      ),
    )

    await expect(loadTree(CAMPAIGN, VAULT_ID, VAULT)).rejects.toThrow(RangeError)
  })
})
