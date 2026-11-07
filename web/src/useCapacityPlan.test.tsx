import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Person, Query } from './capacity'
import { useCapacityPlan } from './useCapacityPlan'
import { PLAN_PREFIX, PLAN_TTL, readRecovery, type SavedPlan } from './planStorage'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
})

const savedQuery: Query = {
  from: '2026-01-05',
  to: '2026-01-18',
  offset: 50,
  search: 'Ana',
  status: 'over',
  sort: 'overload',
}

function backup(uncertain = false): SavedPlan {
  const savedAt = Date.now()
  return {
    version: 1,
    id: 'saved-plan',
    revision: 'saved-revision',
    savedAt,
    expiresAt: savedAt + PLAN_TTL,
    query: savedQuery,
    drafts: [
      {
        id: ana.id,
        name: ana.name,
        expectedWeeklyHours: 40,
        weeklyHours: 50,
        allocatedHours: [...ana.allocatedHours],
      },
    ],
    uncertain,
    reviewedConflict: false,
  }
}

describe('explicit draft recovery', () => {
  it('rejects a prompt that expires before Restore without reading or touching a newer backup', async () => {
    const source = backup()
    localStorage.setItem(PLAN_PREFIX + source.id, JSON.stringify(source))
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const onRestoreQuery = vi.fn()
    const hook = renderHook(() =>
      useCapacityPlan({
        query: savedQuery,
        onRestoreQuery,
        onApplied: vi.fn(),
        onReconcile: vi.fn(),
      }),
    )
    expect(hook.result.current.recovery?.revision).toBe(source.revision)

    vi.spyOn(Date, 'now').mockReturnValue(source.expiresAt)
    const newer = {
      ...source,
      revision: 'newer-revision',
      savedAt: source.expiresAt,
      expiresAt: source.expiresAt + PLAN_TTL,
    }
    localStorage.setItem(PLAN_PREFIX + source.id, JSON.stringify(newer))
    await act(async () => hook.result.current.restore())

    expect(fetchMock).not.toHaveBeenCalled()
    expect(onRestoreQuery).not.toHaveBeenCalled()
    expect(hook.result.current.active).toBe(false)
    expect(hook.result.current.drafts).toEqual([])
    expect(hook.result.current.recovery).toBeNull()
    expect(hook.result.current.recoveryError).toMatch(/saved draft expired/)
    expect(hook.result.current.restoring).toBe(false)
    expect(localStorage.length).toBe(1)
    expect(localStorage.getItem(PLAN_PREFIX + source.id)).toBe(JSON.stringify(newer))
    expect(readRecovery().plan?.revision).toBe(newer.revision)
  })

  it('rejects expiry during canonical reads without publishing a query or active fork', async () => {
    const source = backup()
    localStorage.setItem(PLAN_PREFIX + source.id, JSON.stringify(source))
    let finish!: (response: Response) => void
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const onRestoreQuery = vi.fn()
    const onApplied = vi.fn()
    const hook = renderHook(() =>
      useCapacityPlan({
        query: savedQuery,
        onRestoreQuery,
        onApplied,
        onReconcile: vi.fn(),
      }),
    )
    let restoring!: Promise<void>
    act(() => {
      restoring = hook.result.current.restore()
    })
    expect(hook.result.current.restoring).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.spyOn(Date, 'now').mockReturnValue(source.expiresAt)
    await act(async () => {
      finish(json({ person: { id: ana.id, name: ana.name, weeklyHours: 40 } }))
      await restoring
    })

    expect(onRestoreQuery).not.toHaveBeenCalled()
    expect(onApplied).not.toHaveBeenCalled()
    expect(hook.result.current.active).toBe(false)
    expect(hook.result.current.drafts).toEqual([])
    expect(hook.result.current.recovery).toBeNull()
    expect(hook.result.current.recoveryError).toMatch(/saved draft expired/)
    expect(hook.result.current.restoring).toBe(false)
    expect(localStorage.length).toBe(1)
    expect(localStorage.getItem(PLAN_PREFIX + source.id)).toBe(JSON.stringify(source))
  })

  it('keeps recovery available when saving its fork fails, while the in-memory draft remains usable', async () => {
    const source = backup()
    localStorage.setItem(PLAN_PREFIX + source.id, JSON.stringify(source))
    const originalSet = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith(PLAN_PREFIX)) throw new Error('Quota exceeded')
      return originalSet.call(this, key, value)
    })
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ person: { id: ana.id, name: ana.name, weeklyHours: 40 } })),
    )
    const hook = renderHook(() =>
      useCapacityPlan({
        query: savedQuery,
        onApplied: vi.fn(),
        onReconcile: vi.fn(),
      }),
    )
    await act(async () => hook.result.current.restore())
    expect(hook.result.current.active).toBe(true)
    expect(hook.result.current.storageWarning).toMatch(/recovery is unavailable/)
    expect(localStorage.getItem(PLAN_PREFIX + source.id)).toBe(JSON.stringify(source))
    await act(async () => hook.result.current.stage(bo, 30))
    expect(hook.result.current.drafts).toHaveLength(2)
    act(() => hook.result.current.discard())
    expect(readRecovery().plan).toBeNull()
  })

  it('does not reactivate a recovery that was dismissed while its reads were pending', async () => {
    localStorage.setItem(PLAN_PREFIX + 'saved-plan', JSON.stringify(backup()))
    let finish!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockReturnValue(
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
      ),
    )
    const hook = renderHook(() =>
      useCapacityPlan({
        query: savedQuery,
        onApplied: vi.fn(),
        onReconcile: vi.fn(),
      }),
    )
    let restoring!: Promise<void>
    act(() => {
      restoring = hook.result.current.restore()
    })
    expect(hook.result.current.restoring).toBe(true)
    act(() => hook.result.current.discardRecovery())
    await act(async () => {
      finish(json({ person: { id: ana.id, name: ana.name, weeklyHours: 40 } }))
      await restoring
    })
    expect(hook.result.current.active).toBe(false)
    expect(hook.result.current.recovery).toBeNull()
    expect(hook.result.current.restoring).toBe(false)
  })

  it('backs up staging, restores the exact view after refresh, and only reads until explicit apply', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ person: { id: ana.id, name: ana.name, weeklyHours: 40 } }))
    vi.stubGlobal('fetch', fetchMock)
    const first = renderHook(() =>
      useCapacityPlan({
        query: savedQuery,
        onApplied: vi.fn(),
        onReconcile: vi.fn(),
      }),
    )
    act(() => first.result.current.start())
    await act(async () => first.result.current.stage(ana, 50))
    expect(readRecovery().plan?.drafts[0].weeklyHours).toBe(50)
    first.unmount()

    const onRestoreQuery = vi.fn()
    const second = renderHook(() =>
      useCapacityPlan({
        query: savedQuery,
        onRestoreQuery,
        onApplied: vi.fn(),
        onReconcile: vi.fn(),
      }),
    )
    expect(second.result.current.active).toBe(false)
    expect(second.result.current.recovery?.drafts).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => second.result.current.restore())
    expect(second.result.current.active).toBe(true)
    expect(onRestoreQuery).toHaveBeenCalledWith(savedQuery)
    expect(second.result.current.drafts[0].weeklyHours).toBe(50)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    )
    act(() => second.result.current.discard())
    expect(readRecovery().plan).toBeNull()
  })

  it('reconciles changed baselines for explicit reviewed apply without altering the proposal', async () => {
    localStorage.setItem(PLAN_PREFIX + 'saved-plan', JSON.stringify(backup()))
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ person: { id: ana.id, name: ana.name, weeklyHours: 32 } }))
    vi.stubGlobal('fetch', fetchMock)
    const hook = renderHook(() =>
      useCapacityPlan({
        query: savedQuery,
        onApplied: vi.fn(),
        onReconcile: vi.fn(),
      }),
    )
    await act(async () => hook.result.current.restore())
    expect(hook.result.current.drafts[0]).toMatchObject({
      expectedWeeklyHours: 32,
      weeklyHours: 50,
    })
    expect(hook.result.current.reviewedConflict).toBe(true)
    expect(hook.result.current.error).toMatch(/changed while you were away/)
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true)
  })

  it('persists uncertainty before sending PATCH and restores its unchanged retry payload', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      expect(readRecovery().plan?.uncertain).toBe(true)
      throw new TypeError('Response lost')
    })
    vi.stubGlobal('fetch', fetchMock)
    const first = renderHook(() =>
      useCapacityPlan({
        query: savedQuery,
        onApplied: vi.fn(),
        onReconcile: vi.fn(),
      }),
    )
    act(() => first.result.current.start())
    await act(async () => first.result.current.stage(ana, 50))
    await act(async () => first.result.current.apply())
    const payload = fetchMock.mock.calls[0][1]?.body
    first.unmount()

    fetchMock.mockImplementation(async (_url, init) =>
      init?.method === 'PATCH'
        ? json({ people: [{ id: ana.id, name: ana.name, weeklyHours: 50 }] })
        : json({ person: { id: ana.id, name: ana.name, weeklyHours: 50 } }),
    )
    const second = renderHook(() =>
      useCapacityPlan({
        query: savedQuery,
        onApplied: vi.fn(),
        onReconcile: vi.fn(),
      }),
    )
    await act(async () => second.result.current.restore())
    expect(second.result.current.uncertain).toBe(true)
    expect(second.result.current.drafts[0].expectedWeeklyHours).toBe(40)
    await expect(second.result.current.stage(bo, 30)).rejects.toThrow(/Confirm the previous apply/)
    await act(async () => second.result.current.apply())
    expect(fetchMock.mock.calls.at(-1)?.[1]?.body).toBe(payload)
    expect(readRecovery().plan).toBeNull()
  })

  it('keeps failed recovery available and leaves another plan backup untouched', async () => {
    const source = backup()
    const other = {
      ...backup(),
      id: 'another-tab',
      revision: 'other-revision',
      savedAt: source.savedAt - 1,
      expiresAt: source.expiresAt - 1,
    }
    localStorage.setItem(PLAN_PREFIX + source.id, JSON.stringify(source))
    localStorage.setItem(PLAN_PREFIX + other.id, JSON.stringify(other))
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Offline')))
    const hook = renderHook(() =>
      useCapacityPlan({
        query: savedQuery,
        onApplied: vi.fn(),
        onReconcile: vi.fn(),
      }),
    )
    await act(async () => hook.result.current.restore())
    expect(hook.result.current.active).toBe(false)
    expect(hook.result.current.recoveryError).toBeTruthy()
    expect(hook.result.current.recovery?.id).toBe(source.id)
    act(() => hook.result.current.discardRecovery())
    expect(localStorage.getItem(PLAN_PREFIX + other.id)).toBe(JSON.stringify(other))
    expect(readRecovery().plan?.id).toBe(other.id)
  })
})

const ana: Person = {
  id: 1,
  name: 'Ana Ferreira',
  weeklyHours: 40,
  allocatedHours: [45, 30],
}
const bo: Person = {
  id: 2,
  name: 'Bo Lindqvist',
  weeklyHours: 20,
  allocatedHours: [12, 24],
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

function setup(fetchMock = vi.fn<typeof fetch>()) {
  vi.stubGlobal('fetch', fetchMock)
  const onApplied = vi.fn()
  const onReconcile = vi.fn()
  const hook = renderHook(() => useCapacityPlan({ onApplied, onReconcile }))
  act(() => hook.result.current.start())
  return { ...hook, fetchMock, onApplied, onReconcile }
}

describe('capacity plan staging and atomic application', () => {
  it('previews multiple people without writing and retains each original expected capacity on restaging', async () => {
    const { result, fetchMock, onApplied } = setup(
      vi.fn<typeof fetch>().mockResolvedValue(
        json({
          people: [
            { id: 1, name: ana.name, weeklyHours: 55 },
            { id: 2, name: bo.name, weeklyHours: 24 },
          ],
        }),
      ),
    )
    await act(async () => {
      await result.current.stage(ana, 50)
    })
    await act(async () => {
      await result.current.stage(result.current.project(ana), 55)
    })
    await act(async () => {
      await result.current.stage(bo, 24)
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.project(ana).weeklyHours).toBe(55)
    expect(result.current.project(bo).weeklyHours).toBe(24)
    expect(ana.weeklyHours).toBe(40)
    expect(result.current.project(ana).allocatedHours).toEqual([45, 30])

    await act(async () => {
      await result.current.apply()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/people/capacities')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH')
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(payload.changes).toHaveLength(2)
    expect(payload.changes).toEqual(
      expect.arrayContaining([
        { id: 1, weeklyHours: 55, expectedWeeklyHours: 40 },
        { id: 2, weeklyHours: 24, expectedWeeklyHours: 20 },
      ]),
    )
    expect(onApplied).toHaveBeenCalledTimes(1)
    expect(result.current.active).toBe(false)
  })

  it('removes a no-op restage instead of including an unchanged person in the batch', async () => {
    const { result, fetchMock } = setup(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ people: [{ id: 2, name: bo.name, weeklyHours: 30 }] })),
    )
    await act(async () => {
      await result.current.stage(ana, 50)
    })
    await act(async () => {
      await result.current.stage(result.current.project(ana), 40)
    })
    await act(async () => {
      await result.current.stage(bo, 30)
    })
    expect(result.current.project(ana).weeklyHours).toBe(40)
    await act(async () => {
      await result.current.apply()
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      changes: [{ id: 2, weeklyHours: 30, expectedWeeklyHours: 20 }],
    })
  })

  it('keeps a conflicted plan for review and uses the returned capacities only on an explicit retry', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(
          {
            error: 'Some capacities changed since this plan was prepared.',
            people: [
              { id: 1, name: ana.name, weeklyHours: 32 },
              { id: 2, name: bo.name, weeklyHours: 24 },
            ],
          },
          409,
        ),
      )
      .mockResolvedValueOnce(
        json({
          people: [
            { id: 1, name: ana.name, weeklyHours: 50 },
            { id: 2, name: bo.name, weeklyHours: 30 },
          ],
        }),
      )
    const { result, onApplied } = setup(fetchMock)
    await act(async () => {
      await result.current.stage(ana, 50)
    })
    await act(async () => {
      await result.current.stage(bo, 30)
    })
    await act(async () => {
      await result.current.apply()
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onApplied).not.toHaveBeenCalled()
    expect(result.current.active).toBe(true)
    expect(result.current.reviewedConflict).toBe(true)
    expect(result.current.error).toBeTruthy()
    expect(result.current.project(ana).weeklyHours).toBe(50)
    expect(result.current.project(bo).weeklyHours).toBe(30)

    await act(async () => {
      await result.current.apply()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).changes).toEqual(
      expect.arrayContaining([
        { id: 1, weeklyHours: 50, expectedWeeklyHours: 32 },
        { id: 2, weeklyHours: 30, expectedWeeklyHours: 24 },
      ]),
    )
    expect(onApplied).toHaveBeenCalledTimes(1)
  })

  it('retains an uncertain plan and reconciles server state when it is discarded', async () => {
    const { result, fetchMock, onApplied, onReconcile } = setup(
      vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('Failed to fetch')),
    )
    await act(async () => {
      await result.current.stage(ana, 50)
    })
    await act(async () => {
      await result.current.apply()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.current.active).toBe(true)
    expect(result.current.uncertain).toBe(true)
    expect(result.current.project(ana).weeklyHours).toBe(50)
    expect(onApplied).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.discard()
    })
    expect(result.current.active).toBe(false)
    expect(onReconcile).toHaveBeenCalledTimes(1)
    expect(result.current.project(ana).weeklyHours).toBe(40)
  })

  it('keeps an unconfirmed batch intact until an identical retry confirms it', async () => {
    const { result, fetchMock, onApplied, onReconcile } = setup(
      vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(json({ people: [{ id: 1, name: ana.name, weeklyHours: 50 }] })),
    )
    await act(async () => {
      await result.current.stage(ana, 50)
      await result.current.apply()
    })
    const warning = result.current.error
    expect(warning).toMatch(/Apply was not confirmed/)

    await expect(result.current.stage(bo, 30)).rejects.toThrow(/Confirm the previous apply/)
    await expect(result.current.stage(result.current.project(ana), 40)).rejects.toThrow(
      /Confirm the previous apply/,
    )
    act(() => result.current.remove(ana.id))
    expect(result.current.uncertain).toBe(true)
    expect(result.current.error).toBe(warning)
    expect(result.current.drafts).toHaveLength(1)
    expect(result.current.project(ana).weeklyHours).toBe(50)
    expect(result.current.project(bo).weeklyHours).toBe(20)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.apply()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1]?.body).toBe(fetchMock.mock.calls[0][1]?.body)
    expect(result.current.active).toBe(false)
    expect(result.current.uncertain).toBe(false)
    expect(onApplied).toHaveBeenCalledTimes(1)
    expect(onReconcile).not.toHaveBeenCalled()
  })
})
