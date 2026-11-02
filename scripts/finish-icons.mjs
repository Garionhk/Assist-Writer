// Runs after `tauri icon build/icon.svg -o build/icons` (npm run icon):
// copies the 256 px icon for the window and web favicon, and drops the mobile icons this app doesn't use.
import fs from 'fs'

fs.copyFileSync('build/icons/128x128@2x.png', 'src/renderer/public/icon.png')
for (const dir of ['android', 'ios']) fs.rmSync(`build/icons/${dir}`, { recursive: true, force: true })
console.log('Icons ready: build/icons/icon.ico, src/renderer/public/icon.png')
