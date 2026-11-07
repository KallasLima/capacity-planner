import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearPlan,
  consumeRecovery,
  decodeSavedPlan,
  PLAN_PREFIX,
  PLAN_TTL,
  readRecovery,
  savePlan,
  type SavedPlan,
} from './planStorage'

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
})

function record(id = 'plan-one'): SavedPlan {
  const savedAt = Date.now()
  return {
    version: 1,
    id,
    revision: 'revision-one',
    savedAt,
    expiresAt: savedAt + PLAN_TTL,
    query: {
      from: '2026-01-05',
      to: '2026-01-18',
      offset: 50,
      search: 'Ana',
      status: 'over',
      sort: 'overload',
    },
    drafts: [
      {
        id: 1,
        name: 'Ana',
        expectedWeeklyHours: 40,
        weeklyHours: 50,
        allocatedHours: [45, 30],
      },
    ],
    uncertain: false,
    reviewedConflict: false,
  }
}

describe('versioned browser plan backups', () => {
  it('validates the whole record, its calendar horizon, and finite capacity values', () => {
    const valid = record()
    expect(decodeSavedPlan(JSON.stringify(valid))).toEqual(valid)
    for (const invalid of [
      { ...valid, version: 2 },
      { ...valid, expiresAt: valid.savedAt - 1 },
      { ...valid, query: { ...valid.query, from: '2026-02-30' } },
      { ...valid, query: { ...valid.query, to: '2029-01-01' } },
      { ...valid, drafts: [...valid.drafts, ...valid.drafts] },
      { ...valid, drafts: [{ ...valid.drafts[0], weeklyHours: 0.001 }] },
      { ...valid, drafts: [{ ...valid.drafts[0], allocatedHours: [45] }] },
    ])
      expect(decodeSavedPlan(JSON.stringify(invalid))).toBeNull()
    expect(decodeSavedPlan('{broken')).toBeNull()
  })

  it('cleans expired and malformed scoped records without touching unrelated storage', () => {
    const expired = record()
    expired.savedAt -= PLAN_TTL + 1
    expired.expiresAt -= PLAN_TTL + 1
    localStorage.setItem(PLAN_PREFIX + expired.id, JSON.stringify(expired))
    localStorage.setItem(PLAN_PREFIX + 'broken', '{}')
    localStorage.setItem('unrelated', 'keep')
    expect(readRecovery().plan).toBeNull()
    expect(localStorage.length).toBe(1)
    expect(localStorage.getItem('unrelated')).toBe('keep')
  })

  it('consumes only the selected revision and removes only the active plan key', () => {
    const source = record('source')
    const other = record('other')
    savePlan(source)
    savePlan(other)
    consumeRecovery(source)
    clearPlan(other.id)
    expect(localStorage.getItem(PLAN_PREFIX + source.id)).toBeTruthy()
    expect(localStorage.getItem(PLAN_PREFIX + other.id)).toBeNull()
    expect(readRecovery().plan).toBeNull()

    // A live original tab can write a new revision without a consumed copy hiding it.
    savePlan({ ...source, revision: 'revision-two' })
    expect(readRecovery().plan?.revision).toBe('revision-two')
  })

  it('reports unavailable storage rather than throwing away the in-memory workflow', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded')
    })
    expect(savePlan(record())).toMatch(/recovery is unavailable/)
  })

  it('lets a duplicated original tab retain its source backup after another tab consumes a copy', () => {
    const source = record()
    savePlan(source)
    const pointerKey = 'capacity-grid.plan-pointer.v1'
    const duplicatePointer = sessionStorage.getItem(pointerKey)!
    consumeRecovery(source)
    expect(readRecovery().plan).toBeNull()

    // Duplicated tabs inherit session storage, but their live draft remains theirs.
    sessionStorage.setItem(pointerKey, duplicatePointer)
    expect(readRecovery().plan?.id).toBe(source.id)
    expect(localStorage.getItem(PLAN_PREFIX + source.id)).toBeTruthy()
  })
})
