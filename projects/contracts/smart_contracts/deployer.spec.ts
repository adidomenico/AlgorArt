import { XHDWalletAPI } from '@algorandfoundation/xhd-wallet-api'
import { describe, expect, it } from 'vitest'
import { peraUniversalWalletAccount } from './deployer'

// ARC-52 reference vector: m'/44'/283'/0'/0/0, Peikert mode.
const VECTOR_MNEMONIC =
  'salon zoo engage submit smile frost later decide wing sight chaos renew lizard rely canal coral scene hobby scare step bus leaf tobacco slice'
const VECTOR_ADDRESS = 'PPNHVQJGE6ZMEWPR35UHLUYMCCZV6VNTHLJMZDVCONXKUPV47K4WGQJWGI'

describe('peraUniversalWalletAccount', () => {
  it('derives and signs for the ARC-52 reference vector', async () => {
    const { addr, publicKey, rawSigner } = await peraUniversalWalletAccount(VECTOR_MNEMONIC, VECTOR_ADDRESS)
    expect(addr).toBe(VECTOR_ADDRESS)

    const message = new TextEncoder().encode('kasakame universal wallet signer')
    const signature = await rawSigner(message)
    expect(await new XHDWalletAPI().verifyWithPublicKey(signature, message, publicKey)).toBe(true)
  })

  it('rejects an address that does not belong to the passphrase', async () => {
    await expect(
      peraUniversalWalletAccount(
        VECTOR_MNEMONIC,
        VECTOR_ADDRESS.replace(/./, (c) => (c === 'A' ? 'B' : 'A')),
      ),
    ).rejects.toThrow('No account in the 24-word DEPLOYER_MNEMONIC')
  })
})
