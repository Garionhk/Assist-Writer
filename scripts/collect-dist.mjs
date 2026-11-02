// Gathers the files to share into dist/ (run by `npm run dist` after the Rust builds):
//   AssistWriter-Setup-<v>.exe      installer (Start menu + desktop shortcuts, .awd files)
//   AssistWriter-Portable-<v>.exe   the app itself as one file, runs without installing
//   AssistWriter-Web-<v>/ and .zip  the web version: server + UI + a start script
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'

const version = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8')).version
const dist = 'dist'
// Empty the folder rather than deleting it: Windows refuses to delete a folder that is open
// in Explorer or a terminal.
fs.mkdirSync(dist, { recursive: true })
for (const f of fs.readdirSync(dist)) fs.rmSync(path.join(dist, f), { recursive: true, force: true })

const nsisDir = 'target/release/bundle/nsis'
const setup = fs.readdirSync(nsisDir).find((f) => f.endsWith(`_${version}_x64-setup.exe`))
if (!setup) throw new Error(`No installer for version ${version} in ${nsisDir}`)
fs.copyFileSync(path.join(nsisDir, setup), path.join(dist, `AssistWriter-Setup-${version}.exe`))
fs.copyFileSync('target/release/assist-writer.exe', path.join(dist, `AssistWriter-Portable-${version}.exe`))

const web = path.join(dist, `AssistWriter-Web-${version}`)
fs.mkdirSync(web)
fs.copyFileSync('target/release/assist-writer-server.exe', path.join(web, 'assist-writer-server.exe'))
fs.cpSync('out/renderer', path.join(web, 'ui'), { recursive: true })
fs.writeFileSync(
  path.join(web, 'Start Assist Writer Web.bat'),
  [
    '@echo off',
    'title Assist Writer (Web)',
    'cd /d "%~dp0"',
    'start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:5178"',
    'assist-writer-server.exe',
    'pause',
    ''
  ].join('\r\n')
)
// Windows' built-in tar can write .zip files.
execFileSync('tar', ['-a', '-c', '-f', `AssistWriter-Web-${version}.zip`, `AssistWriter-Web-${version}`], { cwd: dist })

for (const f of fs.readdirSync(dist)) {
  const p = path.join(dist, f)
  const size = fs.statSync(p).isDirectory() ? '(folder)' : `${(fs.statSync(p).size / 1024 / 1024).toFixed(2)} MB`
  console.log(`  ${f.padEnd(36)} ${size}`)
}
