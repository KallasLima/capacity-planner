import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AllocationDetails } from './AllocationDetails'

const dialogMethods = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close'),
}

beforeAll(() => {
  // JSDOM does not implement native dialog presentation; Chrome covers focus and Escape.
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
  for (const name of ['showModal', 'close'] as const) {
    const descriptor = dialogMethods[name]
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

function breakdown(start = '2026-01-05', project = 'Atlas', allocatedHours = 45) {
  return {
    person: { id: 4, name: 'Dee Okafor', weeklyHours: 40 },
    week: { start, end: start === '2026-01-05' ? '2026-01-11' : '2026-01-18' },
    allocatedHours,
    projects: [{ id: 1, name: project, hours: allocatedHours, assignmentCount: 14 }],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function openDetails() {
  return render(
    <AllocationDetails personId={4} personName="Dee Okafor" week="2026-01-05" onClose={vi.fn()} />,
  )
}

describe('AllocationDetails', () => {
  it('keeps saved calculations separate from a zero-hour proposed limit while planning', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(breakdown())))
    render(
      <AllocationDetails
        personId={4}
        personName="Dee Okafor"
        week="2026-01-05"
        onClose={vi.fn()}
        planning
        draftWeeklyHours={0}
      />,
    )
    await screen.findByRole('heading', { name: 'Atlas' })
    expect(screen.getByText('of 40 h saved weekly capacity')).toBeTruthy()
    expect(screen.getByText('0 h / week')).toBeTruthy()
    expect(screen.getByText('5 h over capacity')).toBeTruthy()
    expect(screen.queryByText('45 h over capacity')).toBeNull()
  })

  it('renders the supplied project totals and distinct assignment counts without losing fractional hours', async () => {
    const data = breakdown()
    data.projects = [
      { id: 1, name: 'Atlas', hours: 30.5, assignmentCount: 14 },
      { id: 2, name: 'Support', hours: 14.5, assignmentCount: 2 },
    ]
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(json(data))
    vi.stubGlobal('fetch', fetchMock)
    openDetails()

    const atlasHeading = await screen.findByRole('heading', { name: 'Atlas' })
    const atlas = within(atlasHeading.closest('li')!)
    const support = within(screen.getByRole('heading', { name: 'Support' }).closest('li')!)
    expect(atlas.getByText('14 assignments')).toBeTruthy()
    expect(atlas.getByText(/30\.5/)).toBeTruthy()
    expect(support.getByText('2 assignments')).toBeTruthy()
    expect(support.getByText(/14\.5/)).toBeTruthy()
    const totals = within(screen.getByRole('region', { name: 'Weekly allocation totals' }))
    expect(totals.getByText('5 h over capacity')).toBeTruthy()
    expect(totals.getByText('of 40 h weekly capacity')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/people/4/allocations?week=2026-01-05')
  })

  it('ignores a late previous-week result after navigating to the next week', async () => {
    const old = deferred<Response>()
    const latest = deferred<Response>()
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(latest.promise)
    vi.stubGlobal('fetch', fetchMock)
    openDetails()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Next detail week' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(String(fetchMock.mock.calls[1][0])).toBe('/api/people/4/allocations?week=2026-01-12')
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await act(async () => {
      latest.resolve(json(breakdown('2026-01-12', 'Latest project', 12)))
    })
    await screen.findByRole('heading', { name: 'Latest project' })
    expect(screen.getByText('28 h available')).toBeTruthy()

    // Ignore the AbortSignal in the stub to prove response ordering, not just cancellation.
    await act(async () => {
      old.resolve(json(breakdown('2026-01-05', 'Obsolete project', 45)))
    })
    expect(screen.queryByRole('heading', { name: 'Obsolete project' })).toBeNull()
    expect(screen.queryByText('5 h over capacity')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Latest project' })).toBeTruthy()
    expect(screen.getByText('28 h available')).toBeTruthy()
  })

  it('clears old project details on a failed week request and retries the selected week', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(breakdown()))
      .mockResolvedValueOnce(json({ error: 'Allocation service is temporarily unavailable.' }, 503))
      .mockResolvedValueOnce(json(breakdown('2026-01-12', 'Recovered project', 20)))
    vi.stubGlobal('fetch', fetchMock)
    openDetails()
    await screen.findByRole('heading', { name: 'Atlas' })

    fireEvent.click(screen.getByRole('button', { name: 'Next detail week' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Allocation service is temporarily unavailable.')
    expect(screen.queryByRole('heading', { name: 'Atlas' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Weekly allocation totals' })).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: /^Retry$/ }))
    await screen.findByRole('heading', { name: 'Recovered project' })
    expect(screen.getByText('20 h available')).toBeTruthy()
    expect(String(fetchMock.mock.calls[2][0])).toBe('/api/people/4/allocations?week=2026-01-12')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
