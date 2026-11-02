import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_SETTINGS, Settings } from '../../src/shared/types'
import { dataDir } from './paths'

const settingsPath = (): string => join(dataDir(), 'settings.json')

export function loadSettings(): Settings {
  try {
    // Tolerate a byte-order mark (e.g. after editing the file in Notepad or PowerShell).
    const saved = JSON.parse(readFileSync(settingsPath(), 'utf-8').replace(/^﻿/, ''))
    return { ...DEFAULT_SETTINGS, ...saved }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s: Settings): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...s }
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf-8')
  return merged
}
