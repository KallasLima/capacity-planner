import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CapacityGrid } from './CapacityGrid'
import type { Capacity } from './capacity'
import { PLAN_PREFIX, PLAN_TTL, type SavedPlan } from './planStorage'

const originalDialogMethods = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close'),
}

beforeAll(() => {
  // Native focus trapping is checked in Chrome; JSDOM only needs open/close state.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    },
  })
})

afterAll(() => {
  for (const method of ['showModal', 'close'] as const) {
    const descriptor = originalDialogMethods[method]
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, method, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, method)
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
})

function capacity(name = 'Ana Ferreira', weeklyHours = 40): Capacity {
  return {
    from: '2025-12-29',
    to: '2026-01-18',
    offset: 0,
    limit: 50,
    total: 1,
    weeks: [
      { start: '2025-12-29', end: '2026-01-04' },
      { start: '2026-01-05', end: '2026-01-11' },
      { start: '2026-01-12', end: '2026-01-18' },
    ],
    people: [{ id: 1, name, weeklyHours, allocatedHours: [45, 30, 0] }],
  }
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('CapacityGrid', () => {
  it('keeps saved-draft recovery locked until the ordinary inline edit is finished', async () => {
    const savedAt = Date.now()
    const savedPlan: SavedPlan = {
      version: 1,
      id: 'inline-edit-recovery',
      revision: 'inline-edit-revision',
      savedAt,
      expiresAt: savedAt + PLAN_TTL,
      query: {
        from: '2026-01-05',
        to: '2026-01-25',
        offset: 0,
        search: 'Ana',
        status: 'over',
        sort: 'overload',
      },
      drafts: [
        {
          id: 1,
          name: 'Ana Ferreira',
          expectedWeeklyHours: 40,
          weeklyHours: 50,
          allocatedHours: [45, 30, 0],
        },
      ],
      uncertain: false,
      reviewedConflict: false,
    }
    localStorage.setItem(PLAN_PREFIX + savedPlan.id, JSON.stringify(savedPlan))
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes('/allocations?'))
        return json({
          person: { id: 1, name: 'Ana Ferreira', weeklyHours: 40 },
        })

      const response = capacity()
      const params = new URL(String(input), 'http://localhost').searchParams
      if (params.get('from') === savedPlan.query.from) {
        response.from = '2026-01-05'
        response.to = '2026-01-25'
        response.weeks = [
          { start: '2026-01-05', end: '2026-01-11' },
          { start: '2026-01-12', end: '2026-01-18' },
          { start: '2026-01-19', end: '2026-01-25' },
        ]
      }
      return json(response)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CapacityGrid from="2025-12-29" to="2026-01-16" />)
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Edit weekly capacity for Ana Ferreira',
      }),
    )
    const input = screen.getByRole('spinbutton', {
      name: 'Weekly hours for Ana Ferreira',
    }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '37' } })

    // Recovery must not replace the query and unmount an unrelated unsaved edit.
    for (const name of ['Restore draft', 'Discard saved draft']) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      fireEvent.click(button)
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(input.isConnected).toBe(true)
    expect(input.value).toBe('37')
    expect(localStorage.getItem(PLAN_PREFIX + savedPlan.id)).toBe(JSON.stringify(savedPlan))

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    for (const name of ['Restore draft', 'Discard saved draft'])
      expect(screen.getByRole('button', { name })).toHaveProperty('disabled', false)

    fireEvent.click(screen.getByRole('button', { name: 'Restore draft' }))
    await screen.findByText('1 person changed')
    const restoredEdit = await screen.findByRole('button', {
      name: 'Edit weekly capacity for Ana Ferreira',
    })
    expect(restoredEdit).toHaveProperty('disabled', false)
    expect(screen.getByRole('searchbox', { name: 'Search people' })).toHaveProperty(
      'disabled',
      false,
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.every(([, options]) => options?.method !== 'PATCH')).toBe(true)

    fireEvent.click(restoredEdit)
    expect(
      (
        screen.getByRole('spinbutton', {
          name: 'Weekly hours for Ana Ferreira',
        }) as HTMLInputElement
      ).value,
    ).toBe('50')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('combobox', { name: 'Sort people' })).toHaveProperty('disabled', false)
  })

  it('keeps the searched, prioritized page when planning starts and retains drafts while priority filters change', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const params = new URL(String(input), 'http://localhost').searchParams
      return json({
        ...capacity(),
        total: 120,
        offset: Number(params.get('offset')),
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CapacityGrid from="2025-12-29" to="2026-01-16" />)
    const loaded = () =>
      screen.findByRole('button', {
        name: 'Edit weekly capacity for Ana Ferreira',
      })
    await loaded()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search people' }), {
      target: { value: 'Ana' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Search$/ }))
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Over capacity only' }))
    await loaded()
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort people' }), {
      target: { value: 'overload' },
    })
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Next people' }))
    await loaded()
    const requestsBeforePlanning = fetchMock.mock.calls.length

    fireEvent.click(screen.getByRole('button', { name: 'Plan capacity' }))
    expect(fetchMock).toHaveBeenCalledTimes(requestsBeforePlanning)
    expect(screen.getByText('51–51 of 120')).toBeTruthy()
    expect(
      (
        screen.getByRole('searchbox', {
          name: 'Search people',
        }) as HTMLInputElement
      ).value,
    ).toBe('Ana')
    expect(
      (
        screen.getByRole('combobox', {
          name: 'Sort people',
        }) as HTMLSelectElement
      ).value,
    ).toBe('overload')
    expect(
      screen.getByRole('button', { name: 'Over capacity only' }).getAttribute('aria-pressed'),
    ).toBe('true')
    expect(screen.getByText('Filters and order use saved capacities')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Custom dates' })).toHaveProperty('disabled', true)

    fireEvent.click(await loaded())
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Weekly hours for Ana Ferreira' }), {
      target: { value: '50' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Stage change' }))
    await screen.findByText('1 person changed')

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort people' }), {
      target: { value: 'name' },
    })
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Over capacity only' }))
    await loaded()
    expect(screen.getByText('1 person changed')).toBeTruthy()
    expect(
      screen.getAllByRole('cell', {
        name: /Ana Ferreira, week of .*50 hours capacity, draft capacity/,
      }),
    ).toHaveLength(3)
    const latest = new URL(String(fetchMock.mock.calls.at(-1)![0]), 'http://localhost').searchParams
    expect(latest.get('offset')).toBe('0')
    expect(latest.get('search')).toBe('Ana')
    expect(latest.get('status')).toBeNull()
    expect(fetchMock.mock.calls.every(([, options]) => options?.method !== 'PATCH')).toBe(true)
  })

  it('opens saved project details during a scenario and keeps the proposed capacity after closing them', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }))
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes('/allocations?'))
        return json({
          person: { id: 1, name: 'Ana Ferreira', weeklyHours: 40 },
          week: { start: '2025-12-29', end: '2026-01-04' },
          allocatedHours: 45,
          projects: [{ id: 1, name: 'Atlas', hours: 45, assignmentCount: 2 }],
        })
      return json(capacity())
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CapacityGrid from="2025-12-29" to="2026-01-16" />)
    const edit = await screen.findByRole('button', {
      name: 'Edit weekly capacity for Ana Ferreira',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Plan capacity' }))
    fireEvent.click(edit)
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Weekly hours for Ana Ferreira' }), {
      target: { value: '50' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Stage change' }))
    await screen.findByText('1 person changed')
    fireEvent.click(
      screen.getByRole('button', {
        name: 'View allocation details for Ana Ferreira',
      }),
    )
    const dialog = within(await screen.findByRole('dialog', { name: 'Ana Ferreira' }))
    await dialog.findByRole('heading', { name: 'Atlas' })
    expect(dialog.getByText('of 40 h saved weekly capacity')).toBeTruthy()
    expect(dialog.getByText('50 h / week')).toBeTruthy()
    expect(dialog.getByText('5 h over capacity')).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: 'Close allocation details' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('1 person changed')).toBeTruthy()
    expect(
      screen.getAllByRole('cell', {
        name: /Ana Ferreira, week of .*50 hours capacity, draft capacity/,
      }),
    ).toHaveLength(3)
    expect(fetchMock.mock.calls.every(([, options]) => options?.method !== 'PATCH')).toBe(true)
  })

  it('returns to the first matching page when saving removes the last overloaded person from the final page', async () => {
    let cured = false
    const requestedOffsets: number[] = []
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: index + 1,
      name: `Team member ${String(index + 1).padStart(2, '0')}`,
      weeklyHours: 40,
      allocatedHours: [45, 30, 0],
    }))
    const lastPerson = {
      id: 51,
      name: 'Zoe Last',
      weeklyHours: 40,
      allocatedHours: [45, 30, 0],
    }
    const fetchMock = vi.fn<typeof fetch>(async (input, options) => {
      if (options?.method === 'PATCH') {
        expect(String(input)).toBe('/api/people/51')
        expect(JSON.parse(String(options.body))).toEqual({
          weeklyHours: 50,
          expectedWeeklyHours: 40,
        })
        cured = true
        return json({ id: 51, name: lastPerson.name, weeklyHours: 50 })
      }
      const params = new URL(String(input), 'http://localhost').searchParams
      const offset = Number(params.get('offset'))
      requestedOffsets.push(offset)
      const total = cured && params.get('status') === 'over' ? 50 : 51
      return json({
        ...capacity(),
        offset,
        total,
        people: offset === 0 ? firstPage : total === 51 ? [lastPerson] : [],
        summary: {
          people: total,
          overCapacityPeople: total,
          allocatedHours: total * 75,
          availableHours: total * 50,
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CapacityGrid from="2025-12-29" to="2026-01-16" />)
    await screen.findByRole('button', {
      name: 'Edit weekly capacity for Team member 01',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Over capacity only' }))
    await screen.findByRole('button', {
      name: 'Edit weekly capacity for Team member 01',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next people' }))
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Edit weekly capacity for Zoe Last',
      }),
    )
    fireEvent.change(
      screen.getByRole('spinbutton', {
        name: 'Weekly hours for Zoe Last',
      }),
      { target: { value: '50' } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByRole('button', {
      name: 'Edit weekly capacity for Team member 01',
    })
    expect(screen.getByText('1–50 of 50')).toBeTruthy()
    expect(
      screen.getAllByRole('button', {
        name: /^Edit weekly capacity for/,
      }),
    ).toHaveLength(50)
    expect(requestedOffsets.slice(-2)).toEqual([50, 0])
    expect(screen.queryByText('Everyone is within capacity')).toBeNull()
    expect(
      screen
        .getByRole('button', {
          name: 'Over capacity only',
        })
        .getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it('clears the Drafted confirmation when a staged change is removed or returned to its saved value', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => json(capacity()))
    vi.stubGlobal('fetch', fetchMock)
    render(<CapacityGrid from="2025-12-29" to="2026-01-16" />)
    await screen.findByRole('button', {
      name: 'Edit weekly capacity for Ana Ferreira',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Plan capacity' }))
    const stage = async (value: string) => {
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Edit weekly capacity for Ana Ferreira',
        }),
      )
      fireEvent.change(
        screen.getByRole('spinbutton', {
          name: 'Weekly hours for Ana Ferreira',
        }),
        { target: { value } },
      )
      fireEvent.click(screen.getByRole('button', { name: 'Stage change' }))
      await waitFor(() => expect(screen.queryByRole('spinbutton')).toBeNull())
    }

    await stage('50')
    expect(screen.getByText('Drafted')).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove change for Ana Ferreira',
      }),
    )
    expect(screen.queryByText('Drafted')).toBeNull()
    expect(
      screen.getAllByRole('cell', {
        name: /Ana Ferreira, week of .*40 hours capacity/,
      }),
    ).toHaveLength(3)

    await stage('50')
    expect(screen.getByText('Drafted')).toBeTruthy()
    await stage('40')
    expect(screen.queryByText('Drafted')).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: 'Remove change for Ana Ferreira',
      }),
    ).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses the server summary for the entire matching roster rather than the visible page', async () => {
    const roster = capacity()
    roster.total = 120
    roster.summary = {
      people: 120,
      overCapacityPeople: 17,
      allocatedHours: 12345,
      availableHours: 6789,
    }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(roster)))
    render(<CapacityGrid from="2025-12-29" to="2026-01-16" />)
    await screen.findByRole('button', {
      name: 'Edit weekly capacity for Ana Ferreira',
    })

    const summary = within(screen.getByLabelText('Saved summary of all matching people'))
    for (const value of ['120', '17', '12,345', '6,789'])
      expect(summary.getByText(value)).toBeTruthy()
    expect(screen.getByText('1–1 of 120')).toBeTruthy()
  })

  it('requests roster-wide priority filters and restarts pagination when either changes', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const request = new URL(String(input), 'http://localhost')
      const page = capacity()
      page.total = 120
      page.offset = Number(request.searchParams.get('offset'))
      return json(page)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CapacityGrid from="2025-12-29" to="2026-01-16" />)
    const loaded = () =>
      screen.findByRole('button', {
        name: 'Edit weekly capacity for Ana Ferreira',
      })
    const requestAt = (index: number) =>
      new URL(String(fetchMock.mock.calls[index][0]), 'http://localhost').searchParams
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Next people' }))
    await loaded()
    expect(requestAt(1).get('offset')).toBe('50')

    const filter = screen.getByRole('button', { name: 'Over capacity only' })
    fireEvent.click(filter)
    await loaded()
    expect(requestAt(2).get('status')).toBe('over')
    expect(requestAt(2).get('offset')).toBe('0')
    expect(filter.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Next people' }))
    await loaded()
    expect(requestAt(3).get('offset')).toBe('50')
    expect(requestAt(3).get('status')).toBe('over')

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort people' }), {
      target: { value: 'overload' },
    })
    await loaded()
    expect(requestAt(4).get('sort')).toBe('overload')
    expect(requestAt(4).get('status')).toBe('over')
    expect(requestAt(4).get('offset')).toBe('0')
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('retains a failed save draft, then updates every visible week and overload count on retry', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(capacity()))
      .mockResolvedValueOnce(json({ error: 'Temporary save failure. Please retry.' }, 503))
      .mockResolvedValueOnce(json({ id: 1, name: 'Ana Ferreira', weeklyHours: 50 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<CapacityGrid from="2025-12-29" to="2026-01-16" />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Edit weekly capacity for Ana Ferreira',
      }),
    )
    const input = screen.getByRole('spinbutton', {
      name: 'Weekly hours for Ana Ferreira',
    }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Temporary save failure. Please retry.',
    )
    expect(input.value).toBe('50')
    expect(
      screen.getAllByRole('cell', {
        name: /Ana Ferreira, week of .*40 hours capacity/,
      }),
    ).toHaveLength(3)
    expect(screen.getByTitle('5 h over capacity')).toBeTruthy()
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'PATCH',
      body: '{"weeklyHours":50,"expectedWeeklyHours":40}',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved')
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(
      screen.getAllByRole('cell', {
        name: /Ana Ferreira, week of .*50 hours capacity/,
      }),
    ).toHaveLength(3)
    expect(screen.queryByTitle('5 h over capacity')).toBeNull()
    expect(screen.getByTitle('5 h available')).toBeTruthy()
    expect(screen.getByTitle('20 h available')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each(['Cancel', 'Escape'] as const)(
    'reconciles an uncertain save on %s and restores focus after the delayed server response',
    async (dismiss) => {
      // The server may have committed the PATCH even though its response was lost.
      const reconciliation = deferred<Response>()
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json(capacity()))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockReturnValueOnce(reconciliation.promise)
      vi.stubGlobal('fetch', fetchMock)
      render(<CapacityGrid from="2025-12-29" to="2026-01-16" />)

      fireEvent.click(
        await screen.findByRole('button', {
          name: 'Edit weekly capacity for Ana Ferreira',
        }),
      )
      const input = screen.getByRole('spinbutton', {
        name: 'Weekly hours for Ana Ferreira',
      }) as HTMLInputElement
      fireEvent.change(input, { target: { value: '50' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect((await screen.findByRole('alert')).textContent).toMatch(
        /Save was not confirmed.*draft is kept/,
      )
      expect(input.value).toBe('50')

      if (dismiss === 'Cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      else fireEvent.keyDown(input, { key: 'Escape' })
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
      expect(String(fetchMock.mock.calls[2][0])).toContain('/api/capacity?')
      expect(screen.getByText('Loading capacity…')).toBeTruthy()

      // Resolve only after the old editor has unmounted: focus must survive a real refetch.
      await act(async () => {
        reconciliation.resolve(json(capacity('Ana Ferreira', 50)))
      })
      const editButton = await screen.findByRole('button', {
        name: 'Edit weekly capacity for Ana Ferreira',
      })
      expect(
        screen.getAllByRole('cell', {
          name: /Ana Ferreira, week of .*50 hours capacity/,
        }),
      ).toHaveLength(3)
      await waitFor(() => expect(document.activeElement).toBe(editButton))
      expect(fetchMock).toHaveBeenCalledTimes(3)
    },
  )

  it('keeps the newly selected range when an aborted older request arrives late', async () => {
    // Ignore AbortSignal in the mock so this checks response ordering as well as cancellation.
    const oldRequest = deferred<Response>()
    const currentRequest = deferred<Response>()
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(currentRequest.promise)
    vi.stubGlobal('fetch', fetchMock)
    render(<CapacityGrid from="2025-12-29" to="2026-01-16" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Next week' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(String(fetchMock.mock.calls[1][0])).toContain('from=2026-01-05&to=2026-01-23')
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)

    const latest = capacity('Latest range person')
    latest.from = '2026-01-05'
    latest.to = '2026-01-25'
    latest.weeks = [
      { start: '2026-01-05', end: '2026-01-11' },
      { start: '2026-01-12', end: '2026-01-18' },
      { start: '2026-01-19', end: '2026-01-25' },
    ]
    await act(async () => {
      currentRequest.resolve(json(latest))
    })
    await screen.findByText('Latest range person')

    await act(async () => {
      oldRequest.resolve(json(capacity('Obsolete range person')))
    })
    expect(screen.queryByText('Obsolete range person')).toBeNull()
    expect(screen.getByText('Latest range person')).toBeTruthy()
    if (!screen.queryByLabelText('From'))
      fireEvent.click(screen.getByRole('button', { name: /Custom dates/ }))
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-01-05')
  })

  it('preserves a conflicting draft and requires an explicit save against the latest capacity', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(capacity()))
      .mockResolvedValueOnce(
        json(
          {
            error: 'Weekly capacity changed since you opened this edit.',
            person: { id: 1, name: 'Ana Ferreira', weeklyHours: 32 },
          },
          409,
        ),
      )
      .mockResolvedValueOnce(json({ id: 1, name: 'Ana Ferreira', weeklyHours: 50 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<CapacityGrid from="2025-12-29" to="2026-01-16" />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Edit weekly capacity for Ana Ferreira',
      }),
    )
    const input = screen.getByRole('spinbutton', {
      name: 'Weekly hours for Ana Ferreira',
    }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '50' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    const overwrite = await screen.findByRole('button', {
      name: 'Save my draft',
    })
    expect(input.value).toBe('50')
    expect(
      screen.getAllByRole('cell', {
        name: /Ana Ferreira, week of .*32 hours capacity/,
      }),
    ).toHaveLength(3)
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      weeklyHours: 50,
      expectedWeeklyHours: 40,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fireEvent.click(overwrite)
    await screen.findByText('Saved', { exact: true })
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({
      weeklyHours: 50,
      expectedWeeklyHours: 32,
    })
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(
      screen.getAllByRole('cell', {
        name: /Ana Ferreira, week of .*50 hours capacity/,
      }),
    ).toHaveLength(3)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('searches the roster from its first page and ignores an obsolete page response', async () => {
    const oldPage = deferred<Response>()
    const searchRequest = deferred<Response>()
    const allPeople = capacity()
    allPeople.total = 120
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(allPeople))
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(searchRequest.promise)
      .mockResolvedValueOnce(json(allPeople))
    vi.stubGlobal('fetch', fetchMock)
    render(<CapacityGrid from="2025-12-29" to="2026-01-16" />)
    await screen.findByRole('button', {
      name: 'Edit weekly capacity for Ana Ferreira',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Next people' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(
      new URL(String(fetchMock.mock.calls[1][0]), 'http://localhost').searchParams.get('offset'),
    ).toBe('50')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search people' }), {
      target: { value: 'Ana' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Search$/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    const request = new URL(String(fetchMock.mock.calls[2][0]), 'http://localhost')
    expect(request.searchParams.get('search')).toBe('Ana')
    expect(request.searchParams.get('offset')).toBe('0')
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true)

    await act(async () => {
      searchRequest.resolve(json(capacity('Ana search match')))
    })
    await screen.findByText('Ana search match')
    const obsolete = capacity('Obsolete page person')
    obsolete.offset = 50
    obsolete.total = 120
    await act(async () => {
      oldPage.resolve(json(obsolete))
    })
    expect(screen.queryByText('Obsolete page person')).toBeNull()
    expect(screen.getByText('Ana search match')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    await screen.findByText('Ana Ferreira')
    expect(
      new URL(String(fetchMock.mock.calls[3][0]), 'http://localhost').searchParams.get('search') ??
        '',
    ).toBe('')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
