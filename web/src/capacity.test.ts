import { describe, expect, it } from 'vitest'
import { dateRangeLabel } from './capacity'

describe('calendar range labels', () => {
  it('shows both years for a multi-year history window', () => {
    expect(dateRangeLabel('2024-12-30', '2027-01-03')).toBe('Dec 30, 2024 – Jan 3, 2027')
  })
  it('keeps the year visible for a selected week, including a year boundary', () => {
    expect(dateRangeLabel('2026-01-05', '2026-01-11')).toBe('Jan 5 – Jan 11, 2026')
    expect(dateRangeLabel('2025-12-29', '2026-01-04')).toBe('Dec 29, 2025 – Jan 4, 2026')
  })
})
