import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import type * as XhdWalletApi from '@algorandfoundation/xhd-wallet-api'
import type { Address } from 'algosdk'
import { addressWithSignersFromRawEd25519Signer, encodeAddress } from 'algosdk'
import { mnemonicToSeedSync } from 'bip39'

type XhdWalletModule = typeof XhdWalletApi

// ts-node transpiles dynamic imports in the CommonJS deploy scripts into `require`, which cannot load this ESM-only
// package; a native dynamic import created outside TypeScript's downleveling can.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const nativeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<XhdWalletModule>

async function loadXhdWallet(): Promise<XhdWalletModule> {
  try {
    return await import('@algorandfoundation/xhd-wallet-api')
  } catch {
    return await nativeImport('@algorandfoundation/xhd-wallet-api')
  }
}

/**
 * Derives the Algorand account behind a 24-word Pera Universal Wallet passphrase (BIP-39 HD, ARC-52).
 *
 * The passphrase is scanned across both ARC-52 derivation modes and the first 50 account indexes until the derived
 * address matches `expectedAddress`; the matching key signs with its raw Ed25519 key material (the xHD scalar is not
 * representable as an Algo25 mnemonic).
 *
 * @param mnemonic - the 24-word BIP-39 passphrase
 * @param expectedAddress - the address the passphrase must derive to
 * @returns the matching address, public key, and raw Ed25519 signer
 */
export async function peraUniversalWalletAccount(
  mnemonic: string,
  expectedAddress: string,
): Promise<{ addr: string; publicKey: Uint8Array; rawSigner: (bytes: Uint8Array) => Promise<Uint8Array> }> {
  const { BIP32DerivationType, KeyContext, XHDWalletAPI, fromSeed } = await loadXhdWallet()
  const rootKey = fromSeed(Buffer.from(mnemonicToSeedSync(mnemonic.trim().toLowerCase(), '')))
  const xhd = new XHDWalletAPI()
  for (const mode of [BIP32DerivationType.Peikert, BIP32DerivationType.Khovratovich]) {
    for (let account = 0; account < 50; account++) {
      const publicKey = await xhd.keyGen(rootKey, KeyContext.Address, account, 0, mode)
      if (encodeAddress(publicKey) !== expectedAddress) continue
      return {
        addr: expectedAddress,
        publicKey,
        rawSigner: (bytes) => xhd.signAlgoTransaction(rootKey, KeyContext.Address, account, 0, bytes, mode),
      }
    }
  }
  throw new Error(
    'No account in the 24-word DEPLOYER_MNEMONIC matches DEPLOYER_ADDRESS (checked ARC-52 Peikert/Khovratovich, accounts 0-49).',
  )
}

/**
 * Resolves the deployer account for every deploy-config. On LocalNet this auto-creates and funds a KMD wallet called
 * `DEPLOYER`; elsewhere it reads `DEPLOYER_MNEMONIC` - a 25-word Algo25 phrase, or a 24-word Pera Universal Wallet
 * passphrase together with `DEPLOYER_ADDRESS` (registering a raw signer for the derived account).
 *
 * @param algorand - client whose account manager receives the derived signer
 * @returns the deployer address
 */
export async function resolveDeployerAccount(algorand: AlgorandClient): Promise<{ addr: Address }> {
  const mnemonic = process.env.DEPLOYER_MNEMONIC?.trim()
  if (mnemonic === undefined || mnemonic === '' || mnemonic.split(/\s+/).length !== 24) {
    return algorand.account.fromEnvironment('DEPLOYER')
  }

  const expectedAddress = process.env.DEPLOYER_ADDRESS?.trim()
  if (expectedAddress === undefined || expectedAddress === '') {
    throw new Error('DEPLOYER_ADDRESS is required alongside a 24-word (Pera Universal Wallet) DEPLOYER_MNEMONIC.')
  }

  const { publicKey, rawSigner } = await peraUniversalWalletAccount(mnemonic, expectedAddress)
  const { address, txnSigner } = addressWithSignersFromRawEd25519Signer({
    ed25519PublicKey: publicKey,
    ed25519Signer: rawSigner,
  })
  algorand.account.setSigner(address, txnSigner)
  return { addr: address }
}
