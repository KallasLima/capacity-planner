import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCapacity } from './useCapacity'
import type { Capacity } from './capacity'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const query = { from: '2026-01-05', to: '2026-01-11', offset: 0 }
function capacity(weeklyHours: number): Capacity {
  return {
    ...query,
    weeks: [{ start: query.from, end: query.to }],
    total: 1,
    limit: 50,
    people: [{ id: 1, name: 'Ana Ferreira', weeklyHours, allocatedHours: [45] }],
  }
}
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

describe('useCapacity save reconciliation', () => {
  it('preserves a confirmed edit over a GET that began before the save completed', async () => {
    let finishOlderGet!: (value: Response) => void
    const olderGet = new Promise<Response>((resolve) => {
      finishOlderGet = resolve
    })
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(capacity(40)))
      .mockReturnValueOnce(olderGet)
      .mockResolvedValueOnce(json({ id: 1, name: 'Ana Ferreira', weeklyHours: 50 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useCapacity(query))
    await waitFor(() => expect(result.current.data?.people[0].weeklyHours).toBe(40))

    act(() => result.current.reload())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await act(async () => {
      await result.current.savePerson(1, 50, 40)
    })
    await act(async () => {
      finishOlderGet(json(capacity(40)))
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data?.people[0].weeklyHours).toBe(50)
  })

  it('accepts fresh server changes from GET requests started after a confirmed edit', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(capacity(40)))
      .mockResolvedValueOnce(json({ id: 1, name: 'Ana Ferreira', weeklyHours: 50 }))
      .mockResolvedValueOnce(json(capacity(24)))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useCapacity(query))
    await waitFor(() => expect(result.current.data?.people[0].weeklyHours).toBe(40))

    await act(async () => {
      await result.current.savePerson(1, 50, 40)
    })
    expect(result.current.data?.people[0].weeklyHours).toBe(50)
    act(() => result.current.reload())

    await waitFor(() => expect(result.current.data?.people[0].weeklyHours).toBe(24))
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('includes search in request identity and keeps the latest search when an old response arrives', async () => {
    let finishOld!: (value: Response) => void
    const old = new Promise<Response>((resolve) => {
      finishOld = resolve
    })
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce(
        json({
          ...capacity(40),
          people: [{ id: 2, name: 'Bo', weeklyHours: 40, allocatedHours: [32] }],
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const { result, rerender } = renderHook(({ search }) => useCapacity({ ...query, search }), {
      initialProps: { search: 'Ana' },
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    rerender({ search: 'Bo' })
    await waitFor(() => expect(result.current.data?.people[0].name).toBe('Bo'))
    expect(
      new URL(String(fetchMock.mock.calls[1][0]), 'http://localhost').searchParams.get('search'),
    ).toBe('Bo')
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await act(async () => {
      finishOld(json(capacity(40)))
    })
    expect(result.current.data?.people[0].name).toBe('Bo')
  })
})
