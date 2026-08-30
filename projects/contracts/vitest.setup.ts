import { addEqualityTesters } from '@algorandfoundation/algorand-typescript-testing'
import { beforeAll, expect } from 'vitest'

// Allow vitest to compare Algorand types (uint64, bytes, accounts, ...) against
// native JS values in assertions, e.g. `expect(contract.raised.value).toEqual(1_000_000)`.
beforeAll(() => {
  addEqualityTesters({ expect })
})
