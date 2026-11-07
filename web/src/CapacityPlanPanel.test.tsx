import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapacityPlanPanel } from './CapacityPlanPanel'
import { useCapacityPlan } from './useCapacityPlan'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const ana = {
  id: 1,
  name: 'Ana Ferreira',
  weeklyHours: 40,
  allocatedHours: [45, 30],
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

function Harness({
  onApplied = () => {},
  disabled = false,
}: {
  onApplied?: () => void
  disabled?: boolean
}) {
  const plan = useCapacityPlan({ onApplied, onReconcile: () => {} })
  return (
    <>
      <button onClick={plan.start}>Start fixture plan</button>
      <button onClick={() => plan.stage(ana, 50)}>Stage Ana</button>
      <CapacityPlanPanel plan={plan} disabled={disabled} />
    </>
  )
}

describe('capacity scenario decisions', () => {
  it('shows the draft impact and requires an explicit reviewed-plan action after a conflict', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(
          {
            error: 'Capacity changed.',
            people: [{ id: 1, name: ana.name, weeklyHours: 32 }],
          },
          409,
        ),
      )
      .mockResolvedValueOnce(json({ people: [{ id: 1, name: ana.name, weeklyHours: 50 }] }))
    vi.stubGlobal('fetch', fetchMock)
    const onApplied = vi.fn()
    render(<Harness onApplied={onApplied} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start fixture plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stage Ana' }))
    expect(screen.getByRole('region', { name: 'Capacity scenario' })).toBeTruthy()
    expect(screen.getByText('Overloaded person-weeks: 1 → 0')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Apply plan' }))
    await screen.findByRole('alert')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onApplied).not.toHaveBeenCalled()
    expect(screen.getByText('Ana Ferreira')).toBeTruthy()
    const reviewed = screen.getByRole('button', { name: 'Apply reviewed plan' })
    expect(reviewed).toBeTruthy()
    fireEvent.click(reviewed)
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('region', { name: 'Capacity scenario' })).toBeNull()
  })

  it('locks both apply and discard while the atomic request is pending', async () => {
    let finish!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockReturnValue(
        new Promise((resolve) => {
          finish = resolve
        }),
      ),
    )
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Start fixture plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stage Ana' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply plan' }))
    expect(
      (
        screen.getByRole('button', {
          name: 'Applying plan…',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    expect(
      (
        screen.getByRole('button', {
          name: 'Discard plan',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    finish(json({ people: [{ id: 1, name: ana.name, weeklyHours: 50 }] }))
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Capacity scenario' })).toBeNull(),
    )
  })

  it('preserves the staged plan while an inline editor disables its decisions', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<Harness disabled />)
    fireEvent.click(screen.getByRole('button', { name: 'Start fixture plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stage Ana' }))

    for (const name of ['Apply plan', 'Discard plan', 'Remove change for Ana Ferreira']) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      fireEvent.click(button)
    }
    expect(screen.getByText('Ana Ferreira')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()

    rerender(<Harness />)
    const remove = screen.getByRole('button', {
      name: 'Remove change for Ana Ferreira',
    }) as HTMLButtonElement
    expect(remove.disabled).toBe(false)
    fireEvent.click(remove)
    expect(screen.queryByText('Ana Ferreira')).toBeNull()
    expect(screen.getByRole('region', { name: 'Capacity scenario' })).toBeTruthy()
  })
})
