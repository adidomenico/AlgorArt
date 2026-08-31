import { describe, expect, it } from 'vitest'
import {
  getAlgodConfigFromViteEnvironment,
  getIndexerConfigFromViteEnvironment,
  getKmdConfigFromViteEnvironment,
} from './getAlgoClientConfigs'

describe('getAlgoClientConfigs', () => {
  it('reads algod config from the environment', () => {
    expect(getAlgodConfigFromViteEnvironment().server).toBe('http://localhost')
  })

  it('reads indexer config from the environment', () => {
    expect(getIndexerConfigFromViteEnvironment().server).toBe('http://localhost')
  })

  it('reads kmd config from the environment', () => {
    expect(getKmdConfigFromViteEnvironment().wallet).toBe('unencrypted-default-wallet')
  })
})
