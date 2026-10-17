import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Copy the compiled contract clients and ARC-56 specs into src/generated/ (gitignored). Reuses the contracts
// project's artifacts when they exist and builds the contracts otherwise, so a fresh clone only needs this script.
// The clients trip the strict compiler options (unused locals/parameters), so each copy is tagged with
// `// @ts-nocheck` - the same treatment the frontend applies to its linked clients.

const contractsDir = path.resolve(import.meta.dirname, '../../contracts')
const artifactsDir = path.join(contractsDir, 'smart_contracts', 'artifacts')
const generatedDir = path.resolve(import.meta.dirname, '../src/generated')

function artifactPairs() {
  if (!fs.existsSync(artifactsDir)) return []
  const pairs = []
  for (const entry of fs.readdirSync(artifactsDir)) {
    const dir = path.join(artifactsDir, entry)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('Client.ts')) continue
      const spec = `${file.slice(0, -'Client.ts'.length)}.arc56.json`
      if (!fs.existsSync(path.join(dir, spec))) continue
      pairs.push({ from: path.join(dir, file), name: file }, { from: path.join(dir, spec), name: spec })
    }
  }
  return pairs
}

let pairs = artifactPairs()
if (pairs.length === 0) {
  console.log('no contract artifacts found - building the contracts project')
  execSync('npm run build', { cwd: contractsDir, stdio: 'inherit' })
  pairs = artifactPairs()
}
if (pairs.length === 0) throw new Error(`no contract clients under ${artifactsDir} even after building`)

fs.rmSync(generatedDir, { recursive: true, force: true })
fs.mkdirSync(generatedDir, { recursive: true })
for (const { from, name } of pairs) {
  const source = fs.readFileSync(from, 'utf8')
  fs.writeFileSync(path.join(generatedDir, name), name.endsWith('.ts') ? `// @ts-nocheck\n${source}` : source)
}
console.log(`copied ${String(pairs.length)} files to src/generated/`)
