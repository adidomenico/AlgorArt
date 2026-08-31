import { describe, expect, it } from 'vitest'
import algosdk from 'algosdk'
import { decodeGlobalState, decodePledgeBoxValue, deriveStatus, isCampaignApp, pledgeBoxName, toCampaignViewModel } from './campaign'

const ZERO_ADDRESS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ'

function tealUint(value: bigint): algosdk.indexerModels.TealValue {
  return new algosdk.indexerModels.TealValue({ bytes: new Uint8Array(), type: 2, uint: value })
}

function tealBytes(value: Uint8Array): algosdk.indexerModels.TealValue {
  return new algosdk.indexerModels.TealValue({ bytes: value, type: 1, uint: 0n })
}

function kv(key: string, value: algosdk.indexerModels.TealValue): algosdk.indexerModels.TealKeyValue {
  return new algosdk.indexerModels.TealKeyValue({ key: new TextEncoder().encode(key), value })
}

function appParams(globalState: algosdk.indexerModels.TealKeyValue[]): algosdk.indexerModels.ApplicationParams {
  return new algosdk.indexerModels.ApplicationParams({
    approvalProgram: new Uint8Array(),
    clearStateProgram: new Uint8Array(),
    globalState,
  })
}

function campaignApp(overrides: { status?: bigint; raised?: bigint } = {}): algosdk.indexerModels.Application {
  const globalState = [
    kv('creator', tealBytes(algosdk.decodeAddress(ZERO_ADDRESS).publicKey)),
    kv('goal', tealUint(10_000_000n)),
    kv('deadline', tealUint(2_000n)),
    kv('raised', tealUint(overrides.raised ?? 5_000_000n)),
    kv('status', tealUint(overrides.status ?? 0n)),
  ]
  return new algosdk.indexerModels.Application({ id: 42n, params: appParams(globalState) })
}

describe('decodeGlobalState', () => {
  it('decodes creator, goal, deadline, raised, and status', () => {
    const app = campaignApp()
    const state = decodeGlobalState(app)
    expect(state.creator).toBe(ZERO_ADDRESS)
    expect(state.goal).toBe(10_000_000n)
    expect(state.deadline).toBe(2_000n)
    expect(state.raised).toBe(5_000_000n)
    expect(state.status).toBe(0n)
  })

  it('ignores unknown keys', () => {
    const app = new algosdk.indexerModels.Application({
      id: 1n,
      params: appParams([kv('other', tealUint(7n))]),
    })
    const state = decodeGlobalState(app)
    expect(state).toEqual({})
  })
})

describe('isCampaignApp', () => {
  it('returns true when all known keys are present', () => {
    expect(isCampaignApp(campaignApp())).toBe(true)
  })

  it('returns false for unrelated apps', () => {
    const app = new algosdk.indexerModels.Application({
      id: 1n,
      params: appParams([kv('something-else', tealUint(1n))]),
    })
    expect(isCampaignApp(app)).toBe(false)
  })
})

describe('deriveStatus', () => {
  it('returns claimed when status uint is 2', () => {
    expect(deriveStatus(10n, 10n, 1_000n, 2n, 2_000n)).toBe('claimed')
  })

  it('returns failed when status uint is 1', () => {
    expect(deriveStatus(10n, 10n, 1_000n, 1n, 2_000n)).toBe('failed')
  })

  it('returns funded when deadline passed and goal met', () => {
    expect(deriveStatus(10n, 10n, 1_000n, 0n, 2_000n)).toBe('funded')
  })

  it('returns failed when deadline passed but goal not met (derived, pre-refund)', () => {
    expect(deriveStatus(10n, 5n, 1_000n, 0n, 2_000n)).toBe('failed')
  })

  it('returns failed when the status uint is 1', () => {
    expect(deriveStatus(10n, 5n, 1_000n, 1n, 2_000n)).toBe('failed')
  })

  it('returns open while before the deadline', () => {
    expect(deriveStatus(10n, 10n, 3_000n, 0n, 2_000n)).toBe('open')
  })
})

describe('pledgeBoxName', () => {
  it('prefixes with "p" and appends the 32-byte address', () => {
    const name = pledgeBoxName(ZERO_ADDRESS)
    expect(name.length).toBe(33)
    expect(name[0]).toBe('p'.charCodeAt(0))
    expect(name.slice(1)).toEqual(algosdk.decodeAddress(ZERO_ADDRESS).publicKey)
  })
})

describe('decodePledgeBoxValue', () => {
  it('decodes a big-endian uint64', () => {
    const value = new Uint8Array([0, 0, 0, 0, 0, 0, 1, 0]) // 256
    expect(decodePledgeBoxValue(value)).toBe(256n)
  })
})

describe('toCampaignViewModel', () => {
  it('maps an Application to a view model', () => {
    const vm = toCampaignViewModel(campaignApp({ raised: 10_000_000n }), 3_000n, 250_000n)
    expect(vm.id).toBe(42n)
    expect(vm.creator).toBe(ZERO_ADDRESS)
    expect(vm.goalMicroAlgos).toBe(10_000_000n)
    expect(vm.raisedMicroAlgos).toBe(10_000_000n)
    expect(vm.deadlineSeconds).toBe(2_000n)
    expect(vm.status).toBe('funded')
    expect(vm.myPledgeMicroAlgos).toBe(250_000n)
  })

  it('defaults missing goal/raised to zero', () => {
    const app = new algosdk.indexerModels.Application({
      id: 7n,
      params: appParams([kv('status', tealUint(0n))]),
    })
    const vm = toCampaignViewModel(app, 1_000n)
    expect(vm.goalMicroAlgos).toBe(0n)
    expect(vm.raisedMicroAlgos).toBe(0n)
  })
})
