import { describe, expect, it } from 'vitest'
import { KNOWN_MODEL_BYTES, formatGB, formatVram, vramFit, vramNeeded } from './models'

describe('graphics memory needed by the models', () => {
  const live = KNOWN_MODEL_BYTES['qwen3.5:9b']
  const rewrite = KNOWN_MODEL_BYTES['hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL']

  it('asks for 8 GB for the live model and 16 GB for the rewrite model', () => {
    expect(vramNeeded(live)).toBe(8)
    expect(vramNeeded(rewrite)).toBe(16)
  })

  it('says how each model runs on a given card', () => {
    const a4000 = 17171480576 // RTX A4000, as nvidia-smi reports it: both run fully on it (measured)
    expect(vramFit(rewrite, a4000)).toBe('gpu')
    expect(vramFit(live, 8 * 1024 ** 3)).toBe('gpu')
    expect(vramFit(rewrite, 8 * 1024 ** 3)).toBe('partial')
    expect(vramFit(live, 0)).toBe('cpu')
    expect(formatGB(live)).toBe('6.5 GB')
    expect(formatGB(rewrite)).toBe('14 GB')
    expect(formatVram(a4000)).toBe('16 GB') // as the card is sold, not 17.2 billion bytes
  })
})
