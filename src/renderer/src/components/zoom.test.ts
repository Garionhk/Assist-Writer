import { describe, expect, it } from 'vitest'
import { fitZoom, parseZoom, stepZoom } from './ZoomControl'

describe('view zoom', () => {
  it('fits the page width or the whole page into the window', () => {
    expect(fitZoom('width', 816 + 32, 600)).toBe(1)
    expect(fitZoom('width', 1664, 600)).toBe(2)
    // Whole page: limited by the height here.
    expect(fitZoom('page', 1664, 1056 / 2 + 56)).toBe(0.5)
  })

  it('steps through the zoom levels and stays in range', () => {
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1, -1)).toBe(0.9)
    expect(stepZoom(0.83, 1)).toBe(0.9) // from a fitted zoom
    expect(stepZoom(3, 1)).toBe(3)
    expect(stepZoom(0.5, -1)).toBe(0.5)
  })

  it('reads back a remembered zoom, falling back to 100%', () => {
    expect(parseZoom('1.25')).toBe(1.25)
    expect(parseZoom('width')).toBe('width')
    expect(parseZoom('page')).toBe('page')
    expect(parseZoom(null)).toBe(1)
    expect(parseZoom('nonsense')).toBe(1)
    expect(parseZoom('9')).toBe(3) // kept in range
  })
})
