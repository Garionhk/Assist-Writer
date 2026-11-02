// Model sizes and how much graphics memory (VRAM) they need, for the Setup window.

/** Download sizes of the default models (bytes), so the need is known before downloading. */
export const KNOWN_MODEL_BYTES: Record<string, number> = {
  'qwen3.5:9b': 6.55e9,
  'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL': 14.08e9
}

const GB = 1e9

/**
 * Graphics memory a model needs to run fully on the graphics card: the model itself plus room
 * for the text it works on (about 1 GB for small models, 1.5 GB for large ones), rounded up to
 * whole GB. Measured: qwen3.5:9b (6.6 GB) and the 27B rewrite model (14.1 GB) both run fully on
 * a 16 GB card.
 */
export function vramNeeded(modelBytes: number): number {
  return Math.ceil((modelBytes + (modelBytes > 10 * GB ? 1.5 : 1) * GB) / GB)
}

/**
 * True if a card with this much memory has at least `gb` GB of it. Graphics memory is sold
 * in binary GB (a "16 GB" card has 16 × 1024³ bytes); allow 3% for what the driver reserves.
 */
export function hasVram(vramBytes: number, gb: number): boolean {
  return vramBytes >= gb * 1024 ** 3 * 0.97
}

/** How a model will run with this much graphics memory. */
export function vramFit(modelBytes: number, vramBytes: number): 'gpu' | 'partial' | 'cpu' {
  if (vramBytes <= 0) return 'cpu'
  return hasVram(vramBytes, vramNeeded(modelBytes)) ? 'gpu' : 'partial'
}

/** Graphics memory as it's sold: "16 GB" (binary GB). */
export function formatVram(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 3)} GB`
}

/** Bytes as "6.6 GB". */
export function formatGB(bytes: number): string {
  return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`
}
