## Type checking (`tsconfig.json`)

Already set: `strict`, `noImplicitReturns`, `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`, `isolatedModules`.

Worth adding (both projects):

- `noUncheckedIndexedAccess: true` — biggest single win; catches `arr[i]` / record-access possibly-`undefined` bugs.
- `exactOptionalPropertyTypes: true` — hardens optional props/params (can chafe with React props, so start on contracts, try frontend carefully).

Contracts `tsconfig` already has `noUncheckedSideEffectImports`-eligible TS 5.7 — that one (`noUncheckedSideEffectImports`) is also worth it.
