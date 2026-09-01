import fs from 'node:fs'
import path from 'node:path'

// The generated contract clients in src/contracts/ are build outputs that must
// not be edited by hand. They contain unused imports that trip
// `noUnusedLocals`/`noUnusedParameters`, so prepend `// @ts-nocheck` after each
// `algokit project link` regeneration.

const contractsDir = path.resolve(import.meta.dirname, '../src/contracts')

for (const entry of fs.readdirSync(contractsDir)) {
  if (!entry.endsWith('.ts')) continue

  const filePath = path.join(contractsDir, entry)
  const source = fs.readFileSync(filePath, 'utf8')
  if (source.startsWith('// @ts-nocheck')) continue

  fs.writeFileSync(filePath, `// @ts-nocheck\n${source}`)
}
