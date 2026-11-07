import { useCallback, useEffect, useRef, useState } from 'react'
import {
  capacityInput,
  readResponse,
  type CanonicalPerson,
  type Person,
  type Query,
} from './capacity'
import {
  clearPlan,
  consumeRecovery,
  firstPlanWeek,
  newPlanId,
  PLAN_TTL,
  readRecovery,
  savePlan,
  type SavedPlan,
} from './planStorage'

export type CapacityDraft = {
  id: number
  name: string
  expectedWeeklyHours: number
  weeklyHours: number
  allocatedHours: number[]
}

type Options = {
  onApplied: () => void
  onReconcile: () => void
  query?: Query
  onRestoreQuery?: (query: Query) => void
}

const isPerson = (value: unknown): value is CanonicalPerson =>
  !!value &&
  typeof value === 'object' &&
  'id' in value &&
  typeof value.id === 'number' &&
  'name' in value &&
  typeof value.name === 'string' &&
  'weeklyHours' in value &&
  typeof value.weeklyHours === 'number' &&
  Number.isFinite(value.weeklyHours)

export function useCapacityPlan(options: Options) {
  const [initialRecovery] = useState(readRecovery)
  const [recovery, setRecovery] = useState(initialRecovery.plan)
  const [restoring, setRestoring] = useState(false)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [storageWarning, setStorageWarning] = useState<string | null>(initialRecovery.warning)
  const [active, setActive] = useState(false)
  const [drafts, setDrafts] = useState<CapacityDraft[]>([])
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [reviewedConflict, setReviewedConflict] = useState(false)

  // Refs guard same-tick actions before React has rendered the matching state.
  const draftsRef = useRef(drafts)
  const applyingRef = useRef(false)
  const activeRef = useRef(false)
  const uncertainRef = useRef(false)
  const reviewedConflictRef = useRef(false)
  const restoringRef = useRef(false)
  const recoveryRef = useRef(recovery)
  const restoreVersion = useRef(0)
  const planId = useRef<string | null>(null)
  const planQuery = useRef<Query | null>(null)
  const forkSource = useRef<SavedPlan | null>(null)
  const callbacks = useRef(options)
  callbacks.current = options
  const controller = useRef<AbortController | null>(null)
  const mounted = useRef(true)

  const persist = useCallback((next: CapacityDraft[], pendingApply = uncertainRef.current) => {
    if (!planId.current || !planQuery.current) return
    if (!next.length) {
      setStorageWarning(clearPlan(planId.current))
      return
    }
    const savedAt = Date.now()
    const warning = savePlan({
      version: 1,
      id: planId.current,
      revision: newPlanId(),
      savedAt,
      expiresAt: savedAt + PLAN_TTL,
      query: { ...planQuery.current },
      drafts: next.map((draft) => ({
        ...draft,
        allocatedHours: [...draft.allocatedHours],
      })),
      uncertain: pendingApply,
      reviewedConflict: reviewedConflictRef.current,
    })
    // Do not consume the old backup until its replacement has actually persisted.
    const consumedWarning =
      !warning && forkSource.current ? consumeRecovery(forkSource.current) : null
    if (!warning && !consumedWarning) forkSource.current = null
    setStorageWarning(warning ?? consumedWarning)
  }, [])

  const replace = useCallback(
    (next: CapacityDraft[]) => {
      draftsRef.current = next
      setDrafts(next)
      if (activeRef.current) persist(next)
    },
    [persist],
  )

  const markUncertain = useCallback((value: boolean) => {
    uncertainRef.current = value
    setUncertain(value)
  }, [])

  const markReviewed = useCallback((value: boolean) => {
    reviewedConflictRef.current = value
    setReviewedConflict(value)
  }, [])

  // Filters and page can change during a plan; its allocation horizon cannot.
  useEffect(() => {
    if (!activeRef.current || !options.query || !planQuery.current) return
    if (options.query.from !== planQuery.current.from || options.query.to !== planQuery.current.to)
      return
    planQuery.current = { ...options.query }
    persist(draftsRef.current)
  }, [options.query, persist])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      restoreVersion.current += 1
      controller.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!drafts.length) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [drafts.length])

  const start = useCallback(() => {
    if (applyingRef.current || activeRef.current || restoringRef.current) return
    planId.current = newPlanId()
    planQuery.current = callbacks.current.query ? { ...callbacks.current.query } : null
    forkSource.current = null
    activeRef.current = true
    setActive(true)
    replace([])
    setError(null)
    markUncertain(false)
    markReviewed(false)
    recoveryRef.current = null
    setRecovery(null)
    setRecoveryError(null)
  }, [replace, markUncertain, markReviewed])

  const stage = useCallback(
    async (person: Person, weeklyHours: number) => {
      if (!activeRef.current || applyingRef.current || uncertainRef.current)
        throw new Error(
          'Confirm the previous apply or close and refresh before changing this plan.',
        )
      if (capacityInput(String(weeklyHours)) !== weeklyHours)
        throw new Error('Enter 0–168 hours, with up to 2 decimal places.')

      // Restaging changes the proposal, never the original compare-and-set baseline.
      const previous = draftsRef.current.find((draft) => draft.id === person.id)
      const expected = previous?.expectedWeeklyHours ?? person.weeklyHours
      const remaining = draftsRef.current.filter((draft) => draft.id !== person.id)
      if (weeklyHours !== expected) {
        if (remaining.length >= 100)
          throw new Error('A plan can change up to 100 people. Apply or remove a change first.')
        remaining.push({
          id: person.id,
          name: person.name,
          expectedWeeklyHours: expected,
          weeklyHours,
          allocatedHours: [...person.allocatedHours],
        })
      }
      replace(remaining)
      setError(null)
    },
    [replace],
  )

  const remove = useCallback(
    (id: number) => {
      if (applyingRef.current || uncertainRef.current) return
      replace(draftsRef.current.filter((draft) => draft.id !== id))
    },
    [replace],
  )

  const project = useCallback(
    (person: Person): Person => {
      const draft = drafts.find((change) => change.id === person.id)
      return draft ? { ...person, weeklyHours: draft.weeklyHours } : person
    },
    [drafts],
  )

  const discard = useCallback(() => {
    if (applyingRef.current) return
    activeRef.current = false
    const clearWarning = planId.current ? clearPlan(planId.current) : null
    const sourceWarning = forkSource.current ? consumeRecovery(forkSource.current) : null
    setStorageWarning(clearWarning ?? sourceWarning)
    planId.current = null
    forkSource.current = null
    setActive(false)
    replace([])
    setError(null)
    markUncertain(false)
    markReviewed(false)
    // Refresh even an untouched plan: another manager may have edited its baseline.
    callbacks.current.onReconcile()
  }, [replace, markUncertain, markReviewed])

  const discardRecovery = useCallback(() => {
    restoreVersion.current += 1
    controller.current?.abort()
    restoringRef.current = false
    setRestoring(false)
    if (recoveryRef.current) setStorageWarning(consumeRecovery(recoveryRef.current))
    recoveryRef.current = null
    setRecovery(null)
    setRecoveryError(null)
  }, [])

  const restore = useCallback(async () => {
    const saved = recoveryRef.current
    if (!saved || activeRef.current || applyingRef.current || restoringRef.current) return

    // A displayed recovery prompt can outlive its backup. Recheck at the action
    // boundary and after reads; never renew an expired proposal by forking it.
    const expired = () => {
      if (Date.now() < saved.expiresAt) return false
      if (recoveryRef.current === saved) {
        recoveryRef.current = null
        setRecovery(null)
        setRecoveryError(
          'This saved draft expired. Reload to check for a newer backup, or start a new plan.',
        )
      }
      return true
    }
    if (expired()) return

    const sequence = ++restoreVersion.current
    restoringRef.current = true
    setRestoring(true)
    setRecoveryError(null)
    const abort = new AbortController()
    controller.current = abort
    const timeout = window.setTimeout(() => abort.abort(), 15_000)
    try {
      const current = new Map<number, CanonicalPerson>()
      // The supplied assignments are fixed input. This existing read-only endpoint
      // rechecks every capacity without adding an API or loading whole rosters.
      for (let offset = 0; offset < saved.drafts.length; offset += 5) {
        const people = await Promise.all(
          saved.drafts.slice(offset, offset + 5).map(async (draft) => {
            const params = new URLSearchParams({
              week: firstPlanWeek(saved.query),
            })
            const result = await fetch(`/api/people/${draft.id}/allocations?${params}`, {
              signal: abort.signal,
            }).then(readResponse<{ person: CanonicalPerson }>)
            if (!isPerson(result.person) || result.person.id !== draft.id)
              throw new Error('Could not verify every person in the saved draft.')
            return result.person
          }),
        )
        for (const person of people) current.set(person.id, person)
      }
      if (!mounted.current || sequence !== restoreVersion.current) return
      if (expired()) return

      let changed = saved.reviewedConflict
      const restored = saved.uncertain
        ? saved.drafts
        : saved.drafts.flatMap((draft) => {
            const person = current.get(draft.id)!
            if (person.weeklyHours !== draft.expectedWeeklyHours) changed = true
            return person.weeklyHours === draft.weeklyHours
              ? []
              : [
                  {
                    ...draft,
                    name: person.name,
                    expectedWeeklyHours: person.weeklyHours,
                  },
                ]
          })

      callbacks.current.onRestoreQuery?.({ ...saved.query })
      planQuery.current = { ...saved.query }
      planId.current = newPlanId()
      forkSource.current = saved
      markUncertain(saved.uncertain)
      markReviewed(changed && !saved.uncertain)
      activeRef.current = true
      setActive(true)
      replace(restored)
      if (!restored.length) {
        // All proposals already match saved data; no write is needed.
        setStorageWarning(consumeRecovery(saved))
        forkSource.current = null
        setError('The recovered limits are already saved. Close the plan to return to the roster.')
      } else
        setError(
          saved.uncertain
            ? 'A previous apply was not confirmed. Your original draft is kept unchanged; retry to confirm it, or close and refresh.'
            : changed
              ? 'Saved capacities changed while you were away. Your proposals are kept with the latest starting values; review before applying.'
              : null,
        )
      recoveryRef.current = null
      setRecovery(null)
    } catch (cause) {
      if (!mounted.current || sequence !== restoreVersion.current) return
      setRecoveryError(
        abort.signal.aborted
          ? 'Recovery took too long. Retry or discard the saved draft.'
          : cause instanceof Error
            ? cause.message
            : 'Could not recover the draft. Please try again.',
      )
    } finally {
      window.clearTimeout(timeout)
      if (mounted.current && sequence === restoreVersion.current) {
        restoringRef.current = false
        setRestoring(false)
      }
    }
  }, [markReviewed, markUncertain, replace])

  const apply = useCallback(async () => {
    if (applyingRef.current || !activeRef.current || !draftsRef.current.length) return
    applyingRef.current = true
    setApplying(true)
    setError(null)
    const abort = new AbortController()
    controller.current = abort
    const timeout = window.setTimeout(() => abort.abort(), 15_000)

    // Send one batch so a conflict cannot leave half the scenario saved.
    const changes = draftsRef.current.map(({ id, weeklyHours, expectedWeeklyHours }) => ({
      id,
      weeklyHours,
      expectedWeeklyHours,
    }))
    // A refresh while PATCH is in flight must recover an uncertain operation,
    // never an ordinary unsent draft. Storage failures leave the tab usable.
    persist(draftsRef.current, true)
    try {
      const response = await fetch('/api/people/capacities', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
        signal: abort.signal,
      })
      const body: unknown = await response.json()
      if (!mounted.current) return

      // Rebase expected values only after a confirmed conflict, then ask for review.
      if (
        response.status === 409 &&
        body &&
        typeof body === 'object' &&
        'people' in body &&
        Array.isArray(body.people) &&
        body.people.every(isPerson)
      ) {
        const current = new Map(body.people.map((person) => [person.id, person]))
        replace(
          draftsRef.current.flatMap((draft) => {
            const person = current.get(draft.id)
            if (!person) return [draft]
            return person.weeklyHours === draft.weeklyHours
              ? []
              : [{ ...draft, expectedWeeklyHours: person.weeklyHours }]
          }),
        )
        markReviewed(true)
        markUncertain(false)
        persist(draftsRef.current)
        setError(
          'Some capacities changed elsewhere. This attempt applied no changes. Your draft is kept with the latest starting values; review it before applying again.',
        )
        callbacks.current.onReconcile()
        return
      }

      if (!response.ok) {
        markUncertain(response.status >= 500)
        persist(draftsRef.current)
        const message =
          body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
            ? body.error
            : 'The plan could not be applied. Please try again.'
        setError(message)
        return
      }

      activeRef.current = false
      const clearWarning = planId.current ? clearPlan(planId.current) : null
      const sourceWarning = forkSource.current ? consumeRecovery(forkSource.current) : null
      setStorageWarning(clearWarning ?? sourceWarning)
      planId.current = null
      forkSource.current = null
      setActive(false)
      replace([])
      markUncertain(false)
      markReviewed(false)
      callbacks.current.onApplied()
    } catch {
      if (!mounted.current) return

      // The server may have committed. Freeze the payload so an identical retry
      // can confirm it safely, or reconcile saved values when the plan is closed.
      markUncertain(true)
      persist(draftsRef.current)
      setError(
        'Apply was not confirmed. Your draft is kept. Retry safely, or close the plan and refresh current values.',
      )
    } finally {
      window.clearTimeout(timeout)
      applyingRef.current = false
      if (mounted.current) setApplying(false)
    }
  }, [replace, markUncertain, markReviewed, persist])

  return {
    active,
    start,
    discard,
    drafts,
    project,
    stage,
    apply,
    applying,
    error,
    uncertain,
    reviewedConflict,
    remove,
    recovery,
    restore,
    discardRecovery,
    restoring,
    recoveryError,
    storageWarning,
  }
}

export type CapacityPlan = ReturnType<typeof useCapacityPlan>
