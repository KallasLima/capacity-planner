import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlanRecovery } from './PlanRecovery'
import type { CapacityPlan } from './useCapacityPlan'

afterEach(cleanup)

const savedDraft = {
  id: 'recovery-fixture',
  version: 1,
  savedAt: Date.parse('2026-11-03T12:00:00Z'),
  expiresAt: Date.parse('2026-11-04T12:00:00Z'),
  query: {
    from: '2025-12-29',
    to: '2026-02-08',
    offset: 0,
    search: '',
    status: 'over',
    sort: 'overload',
  },
  drafts: [
    {
      id: 4,
      name: 'Dee Okafor',
      expectedWeeklyHours: 40,
      weeklyHours: 50,
      allocatedHours: [0, 45, 40, 0, 0, 0],
    },
  ],
  uncertain: false,
  reviewedConflict: false,
}

function planFixture(overrides: Record<string, unknown> = {}): CapacityPlan {
  // Only the recovery surface is exercised here; hook persistence has its own tests.
  return {
    active: false,
    recovery: savedDraft,
    restoring: false,
    recoveryError: null,
    storageWarning: null,
    restore: vi.fn().mockResolvedValue(undefined),
    discardRecovery: vi.fn(),
    ...overrides,
  } as unknown as CapacityPlan
}

describe('saved capacity draft decisions', () => {
  it('requires an explicit restore or discard without taking action on mount', () => {
    const restore = vi.fn().mockResolvedValue(undefined)
    const discardRecovery = vi.fn()
    render(<PlanRecovery plan={planFixture({ restore, discardRecovery })} />)

    expect(screen.getByRole('region', { name: 'Saved capacity draft' })).toBeTruthy()
    expect(screen.getByText(/1 person planned/)).toBeTruthy()
    expect(screen.getByText(/Dec 29, 2025.*Feb 8, 2026/)).toBeTruthy()
    expect(screen.getByText(/Restoring does not save changes/)).toBeTruthy()
    expect(restore).not.toHaveBeenCalled()
    expect(discardRecovery).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Restore draft' }))
    expect(restore).toHaveBeenCalledTimes(1)
    expect(discardRecovery).not.toHaveBeenCalled()
  })

  it('locks both recovery decisions while canonical values are being checked', () => {
    const restore = vi.fn().mockResolvedValue(undefined)
    const discardRecovery = vi.fn()
    render(<PlanRecovery plan={planFixture({ restoring: true, restore, discardRecovery })} />)

    for (const name of ['Restoring draft…', 'Discard saved draft']) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      fireEvent.click(button)
    }
    expect(restore).not.toHaveBeenCalled()
    expect(discardRecovery).not.toHaveBeenCalled()
  })

  it('keeps recovery decisions locked while the surrounding grid has an unfinished edit', () => {
    const restore = vi.fn().mockResolvedValue(undefined)
    const discardRecovery = vi.fn()
    const plan = planFixture({ restore, discardRecovery })
    const { rerender } = render(<PlanRecovery plan={plan} disabled />)

    // External edit locking must not depend on restoration already being in flight.
    for (const name of ['Restore draft', 'Discard saved draft']) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      fireEvent.click(button)
    }
    expect(restore).not.toHaveBeenCalled()
    expect(discardRecovery).not.toHaveBeenCalled()

    rerender(<PlanRecovery plan={plan} />)
    const restoreButton = screen.getByRole('button', {
      name: 'Restore draft',
    }) as HTMLButtonElement
    expect(restoreButton.disabled).toBe(false)
    fireEvent.click(restoreButton)
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('keeps failed recovery actionable and distinguishes an uncertain earlier apply', () => {
    const restore = vi.fn().mockResolvedValue(undefined)
    const discardRecovery = vi.fn()
    render(
      <PlanRecovery
        plan={planFixture({
          recovery: { ...savedDraft, uncertain: true },
          recoveryError: 'Current capacities could not be checked. Try again.',
          restore,
          discardRecovery,
        })}
      />,
    )

    expect(screen.getByRole('alert').textContent).toContain('Try again')
    expect(screen.getByRole('status').textContent).toContain('may have reached the server')
    expect(screen.getByRole('status').textContent).toContain('original changes')
    expect(
      (
        screen.getByRole('button', {
          name: 'Restore draft',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Discard saved draft' }))
    expect(discardRecovery).toHaveBeenCalledTimes(1)
    expect(restore).not.toHaveBeenCalled()
  })

  it('shows unavailable-storage feedback even without a saved record', () => {
    render(
      <PlanRecovery
        plan={planFixture({
          recovery: null,
          storageWarning: 'Draft recovery is unavailable. Keep this tab open.',
        })}
      />,
    )

    expect(screen.getByRole('status').textContent).toContain('Keep this tab open')
    expect(screen.queryByRole('button', { name: 'Restore draft' })).toBeNull()
  })

  it('does not offer to replace an active plan with another saved draft', () => {
    const { rerender } = render(<PlanRecovery plan={planFixture({ active: true })} />)
    expect(screen.queryByRole('region', { name: 'Saved capacity draft' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restore draft' })).toBeNull()

    rerender(
      <PlanRecovery
        plan={planFixture({
          active: true,
          storageWarning: 'Draft recovery is unavailable. Keep this tab open.',
        })}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('Keep this tab open')
    expect(screen.queryByRole('heading', { name: 'Resume your capacity draft' })).toBeNull()
  })
})
