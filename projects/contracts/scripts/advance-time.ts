import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'

/**
 * Move the LocalNet chain clock forward (devmode block-offset timestamp) and mine a block at the new time.
 *
 * LocalNet only — never run against TestNet/MainNet. Used to expire campaign
 * deadlines (or refund windows) while testing the UI by hand.
 *
 * Usage: `SECONDS=<offset> npx ts-node --transpile-only scripts/advance-time.ts`
 *
 * `SECONDS` replaces the current offset (it does not add to it); `SECONDS=0`
 * resets the clock to real time. The offset persists on the sandbox until
 * changed — new blocks keep the shifted time, so campaigns created afterwards
 * use it as their baseline. Prints the resulting chain time.
 */
void (async () => {
  const seconds = process.env.SECONDS
  if (seconds === undefined || seconds === '') {
    throw new Error('SECONDS must be set (offset from real time, e.g. 2592000 for 30 days; 0 resets).')
  }

  const algorand = AlgorandClient.defaultLocalNet()
  const dispenser = await algorand.account.localNetDispenser()
  await algorand.client.algod.setBlockOffsetTimestamp(Number(seconds)).do()
  // Mine a block so the new time takes effect immediately.
  await algorand.send.payment({ sender: dispenser.addr, receiver: dispenser.addr, amount: microAlgos(1000n) })

  const status = await algorand.client.algod.status().do()
  const block = await algorand.client.algod.block(status.lastRound).do()
  console.log(
    `round ${String(status.lastRound)} chain time: ${new Date(Number(block.block.header.timestamp) * 1000).toISOString()} (offset ${seconds}s)`,
  )
})()
