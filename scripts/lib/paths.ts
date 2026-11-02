import { homedir } from 'os'
import { join } from 'path'

/**
 * Where settings live. Shared by the desktop app and the web server so both use the same
 * models, styles and preferences.
 */
export function dataDir(): string {
  // Override for tests, so they never touch the real settings.
  if (process.env.ASSIST_WRITER_DATA) return process.env.ASSIST_WRITER_DATA
  const base = process.env.APPDATA ?? join(homedir(), '.config')
  return join(base, 'assist-writer')
}

/** The documents library: a normal folder of .awd files the user can also browse. */
export function libraryDir(): string {
  return process.env.ASSIST_WRITER_LIBRARY ?? join(homedir(), 'Documents', 'Assist Writer')
}
