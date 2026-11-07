import { useCallback, useEffect, useRef, useState } from 'react'
import {
  readResponse,
  CapacityConflictError,
  type CanonicalPerson,
  type Capacity,
  type Query,
  type Person,
  type CapacitySummary,
} from './capacity'

// Reconcile the saved roster summary without recomputing every visible week.
// Under the overload filter, changing capacity can also change roster membership.
function changedSummary(
  summary: CapacitySummary | undefined,
  before: Person,
  weeklyHours: number,
  status: string,
) {
  if (!summary) return undefined

  const wasOver = before.allocatedHours.some((value) => value > before.weeklyHours)
  const nowOver = before.allocatedHours.some((value) => value > weeklyHours)
  const previouslyIncluded = status !== 'over' || wasOver
  const nowIncluded = status !== 'over' || nowOver
  const allocated = before.allocatedHours.reduce((sum, value) => sum + value, 0)
  const oldAvailable = before.allocatedHours.reduce(
    (sum, value) => sum + Math.max(0, before.weeklyHours - value),
    0,
  )
  const newAvailable = before.allocatedHours.reduce(
    (sum, value) => sum + Math.max(0, weeklyHours - value),
    0,
  )

  return {
    people: summary.people + Number(nowIncluded) - Number(previouslyIncluded),
    overCapacityPeople:
      summary.overCapacityPeople +
      Number(nowIncluded && nowOver) -
      Number(previouslyIncluded && wasOver),
    allocatedHours:
      summary.allocatedHours + (Number(nowIncluded) - Number(previouslyIncluded)) * allocated,
    availableHours:
      summary.availableHours +
      (nowIncluded ? newAvailable : 0) -
      (previouslyIncluded ? oldAvailable : 0),
  }
}

type Snapshot = {
  key: string
  data: Capacity | null
  loading: boolean
  error: string | null
}

export function useCapacity(query: Query) {
  const search = query.search?.trim() ?? ''
  const status = query.status ?? 'all'
  const sort = query.sort ?? 'name'

  // A response belongs to exactly one range, roster page, and filter selection.
  const key = `${query.from}/${query.to}/${query.offset}/${search}/${status}/${sort}`

  const [revision, setRevision] = useState(0)
  const [snapshot, setSnapshot] = useState<Snapshot>({
    key: '',
    data: null,
    loading: true,
    error: null,
  })
  const [savingId, setSavingId] = useState<number | null>(null)

  // Request identity rejects late loads; mutation versions preserve newer saves.
  const request = useRef(0)
  const mutationVersion = useRef(0)
  const savedHours = useRef(new Map<number, { hours: number; version: number }>())

  useEffect(() => {
    const sequence = ++request.current
    const versionAtStart = mutationVersion.current
    const controller = new AbortController()
    let disposed = false
    const timeout = window.setTimeout(() => controller.abort(), 15_000)

    setSnapshot({ key, data: null, loading: true, error: null })

    const params = new URLSearchParams({
      from: query.from,
      to: query.to,
      offset: String(query.offset),
      limit: '50',
    })

    if (search) params.set('search', search)
    if (status !== 'all') params.set('status', status)
    if (sort !== 'name') params.set('sort', sort)

    fetch(`/api/capacity?${params}`, { signal: controller.signal })
      .then(readResponse<Capacity>)
      .then((data) => {
        if (disposed || sequence !== request.current) return

        // Only reconcile edits confirmed after this request began. Later requests
        // remain authoritative, including changes made by another manager.
        let summary = data.summary
        const people = data.people.map((person) => {
          const saved = savedHours.current.get(person.id)
          if (saved && saved.version > versionAtStart) {
            summary = changedSummary(summary, person, saved.hours, status)
            return { ...person, weeklyHours: saved.hours }
          }
          return person
        })

        setSnapshot({
          key,
          data: { ...data, people, summary },
          loading: false,
          error: null,
        })
      })
      .catch((error: unknown) => {
        if (disposed || sequence !== request.current) return
        const message = controller.signal.aborted
          ? 'The request took too long. Please try again.'
          : error instanceof Error
            ? error.message
            : 'Could not load capacity.'
        setSnapshot({ key, data: null, loading: false, error: message })
      })
      .finally(() => window.clearTimeout(timeout))

    return () => {
      disposed = true
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [key, query.from, query.to, query.offset, search, status, sort, revision])

  // Accept both successful saves and canonical conflict values through one path.
  const acceptPerson = useCallback(
    (person: CanonicalPerson) => {
      savedHours.current.set(person.id, {
        hours: person.weeklyHours,
        version: ++mutationVersion.current,
      })

      setSnapshot((current) => {
        if (!current.data) return current

        const before = current.data.people.find((row) => row.id === person.id)

        return {
          ...current,
          data: {
            ...current.data,
            summary: before
              ? changedSummary(current.data.summary, before, person.weeklyHours, status)
              : current.data.summary,
            people: current.data.people.map((row) =>
              row.id === person.id
                ? {
                    ...row,
                    name: person.name,
                    weeklyHours: person.weeklyHours,
                  }
                : row,
            ),
          },
        }
      })
    },
    [status],
  )

  // Hide stale numbers while reconciling an uncertain result or changed ordering.
  const reload = useCallback(() => {
    setSnapshot((current) => ({
      ...current,
      data: null,
      loading: true,
      error: null,
    }))
    setRevision((value) => value + 1)
  }, [])

  const savePerson = useCallback(
    async (id: number, weeklyHours: number, expectedWeeklyHours: number) => {
      setSavingId(id)
      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), 15_000)

      try {
        // Compare-and-set prevents silently overwriting another manager's edit.
        const person = await fetch(`/api/people/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ weeklyHours, expectedWeeklyHours }),
          signal: controller.signal,
        }).then(readResponse<CanonicalPerson>)

        acceptPerson(person)

        // Filter membership and ranking must be resolved by the whole-roster query.
        if (status === 'over' || sort === 'overload') reload()
      } catch (error) {
        if (error instanceof CapacityConflictError) acceptPerson(error.currentPerson)

        // A lost response can follow a committed write: keep the draft and reload
        // on Cancel rather than assuming the server retained the old capacity.
        if (controller.signal.aborted)
          throw new Error(
            'Save timed out. Your draft is kept; retry, or cancel to reload current capacity.',
          )
        if (error instanceof TypeError)
          throw new Error(
            'Save was not confirmed. Your draft is kept; retry, or cancel to reload current capacity.',
          )
        throw error
      } finally {
        window.clearTimeout(timeout)
        setSavingId(null)
      }
    },
    [acceptPerson, reload, status, sort],
  )

  return {
    data: snapshot.key === key ? snapshot.data : null,
    loading: snapshot.key !== key || snapshot.loading,
    error: snapshot.key === key ? snapshot.error : null,
    savingId,
    savePerson,
    reload,
  }
}
