// Used by the .bat launchers: exits with code 1 when a build output is missing or older than
// any of its sources, so the launcher only rebuilds when something changed.
//   node scripts/needs-build.mjs <output file> <source folder or file>...
import fs from 'fs'
import path from 'path'

const [output, ...sources] = process.argv.slice(2)
const built = fs.existsSync(output) ? fs.statSync(output).mtimeMs : 0

function newest(p) {
  if (!fs.existsSync(p)) return 0
  const s = fs.statSync(p)
  if (!s.isDirectory()) return s.mtimeMs
  let max = 0
  for (const e of fs.readdirSync(p)) {
    if (e === 'node_modules' || e === 'target' || e === 'gen') continue
    max = Math.max(max, newest(path.join(p, e)))
  }
  return max
}

process.exit(built && sources.every((s) => newest(s) <= built) ? 0 : 1)
