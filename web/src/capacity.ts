// Each allocation slot corresponds to the same index in Capacity.weeks.
// Capacity is a recurring weekly limit, rather than a date-specific schedule.
export type Person = {
  id: number
  name: string
  weeklyHours: number
  allocatedHours: number[]
}

export type Week = { start: string; end: string }

// People are paged; summary describes the entire searched and filtered roster.
export type Capacity = {
  from: string
  to: string
  weeks: Week[]
  people: Person[]
  total: number
  offset: number
  limit: number
  summary?: CapacitySummary
}

export type CapacitySummary = {
  people: number
  overCapacityPeople: number
  allocatedHours: number
  availableHours: number
}

export type Query = {
  from: string
  to: string
  offset: number
  search?: string
  status?: 'all' | 'over'
  sort?: 'name' | 'overload'
}

export type CanonicalPerson = Pick<Person, 'id' | 'name' | 'weeklyHours'>

// A conflict carries authoritative values while the editor retains its proposal.
export class CapacityConflictError extends Error {
  constructor(readonly currentPerson: CanonicalPerson) {
    super('Weekly capacity changed since you opened this edit.')
    this.name = 'CapacityConflictError'
  }
}

const hourFormatter = new Intl.NumberFormat('en', { maximumFractionDigits: 2 })

export const hours = (value: number) => hourFormatter.format(value)

// API dates are calendar days. UTC formatting avoids a timezone shifting the day.
export const dateLabel = (
  value: string,
  options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' },
) =>
  new Intl.DateTimeFormat('en', { ...options, timeZone: 'UTC' }).format(
    new Date(`${value}T12:00:00Z`),
  )

export function dateRangeLabel(from: string, to: string) {
  const end = dateLabel(to, { month: 'short', day: 'numeric', year: 'numeric' })
  const start =
    from.slice(0, 4) === to.slice(0, 4)
      ? dateLabel(from)
      : dateLabel(from, { month: 'short', day: 'numeric', year: 'numeric' })

  return `${start} – ${end}`
}

export function shiftDate(value: string, days: number) {
  // Use UTC calendar arithmetic so daylight-saving changes cannot skip a date.
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)

  return date.toISOString().slice(0, 10)
}

// Match server precision and bounds before offering a save or scenario change.
export function capacityInput(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null

  const result = Number(value)

  return Number.isFinite(result) && result >= 0 && result <= 168 ? result : null
}

// Normalize API failures in one place; preserve structured conflicts for editors.
export async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text()
    let message = body.trim()

    if (response.headers.get('content-type')?.includes('application/json')) {
      try {
        const parsed: unknown = JSON.parse(body)
        if (
          parsed &&
          typeof parsed === 'object' &&
          'error' in parsed &&
          typeof parsed.error === 'string'
        )
          message = parsed.error
        // Only a validated canonical person is safe to reconcile into the grid.
        if (response.status === 409 && parsed && typeof parsed === 'object' && 'person' in parsed) {
          const person = parsed.person
          if (
            person &&
            typeof person === 'object' &&
            'id' in person &&
            'name' in person &&
            'weeklyHours' in person &&
            typeof person.id === 'number' &&
            Number.isInteger(person.id) &&
            typeof person.name === 'string' &&
            typeof person.weeklyHours === 'number' &&
            Number.isFinite(person.weeklyHours)
          ) {
            throw new CapacityConflictError(person as CanonicalPerson)
          }
        }
      } catch (error) {
        if (error instanceof CapacityConflictError) throw error
        message = ''
      }
    }

    throw new Error(message || `Request failed (${response.status}).`)
  }

  return response.json() as Promise<T>
}
