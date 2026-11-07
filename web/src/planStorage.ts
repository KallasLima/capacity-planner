import { capacityInput, type Query } from './capacity'
import type { CapacityDraft } from './useCapacityPlan'

export const PLAN_PREFIX = 'capacity-grid.plan.v1:'
const CONSUMED_PREFIX = 'capacity-grid.plan-consumed.v1:'
const POINTER_KEY = 'capacity-grid.plan-pointer.v1'
export const PLAN_TTL = 24 * 60 * 60 * 1000
const MAX_BYTES = 256 * 1024

export type SavedPlan = {
  version: 1
  id: string
  revision: string
  savedAt: number
  expiresAt: number
  query: Query
  drafts: CapacityDraft[]
  uncertain: boolean
  reviewedConflict: boolean
}

export const recoveryUnavailable =
  'Draft recovery is unavailable in this browser. Keep this tab open until you apply or discard the plan.'

export function newPlanId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}

function dateValue(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const stamp = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(stamp) || value.slice(0, 4) === '0000') return null
  return new Date(stamp).toISOString().slice(0, 10) === value ? stamp : null
}

export function firstPlanWeek(query: Query) {
  const start = new Date(`${query.from}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7))
  return start.toISOString().slice(0, 10)
}

export function planWeekCount(query: Query): number | null {
  const from = dateValue(query.from)
  const to = dateValue(query.to)
  if (from === null || to === null || to < from) return null
  const first = Date.parse(`${firstPlanWeek(query)}T00:00:00Z`)
  const end = new Date(to)
  end.setUTCDate(end.getUTCDate() - ((end.getUTCDay() + 6) % 7))
  const weeks = (end.getTime() - first) / (7 * 86_400_000) + 1
  end.setUTCDate(end.getUTCDate() + 6)
  return weeks <= 106 && end.getUTCFullYear() <= 9999 ? weeks : null
}

function validQuery(value: unknown): value is Query {
  if (!value || typeof value !== 'object') return false
  const query = value as Query
  return (
    planWeekCount(query) !== null &&
    Number.isSafeInteger(query.offset) &&
    query.offset >= 0 &&
    (query.search === undefined ||
      (typeof query.search === 'string' && [...query.search].length <= 100)) &&
    (query.status === undefined || query.status === 'all' || query.status === 'over') &&
    (query.sort === undefined || query.sort === 'name' || query.sort === 'overload')
  )
}

function validHours(value: unknown): value is number {
  return typeof value === 'number' && capacityInput(String(value)) === value
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value)
}

// Browser storage is untrusted input. Reject whole records rather than restoring
// a partially valid proposal with a different meaning.
export function decodeSavedPlan(raw: string, now = Date.now()): SavedPlan | null {
  if (raw.length > MAX_BYTES) return null
  try {
    const value = JSON.parse(raw) as SavedPlan
    if (
      !value ||
      value.version !== 1 ||
      !validId(value.id) ||
      !validId(value.revision) ||
      !Number.isSafeInteger(value.savedAt) ||
      value.savedAt < 0 ||
      value.savedAt > now + 300_000 ||
      value.expiresAt !== value.savedAt + PLAN_TTL ||
      value.expiresAt <= now ||
      !validQuery(value.query) ||
      typeof value.uncertain !== 'boolean' ||
      typeof value.reviewedConflict !== 'boolean' ||
      !Array.isArray(value.drafts) ||
      value.drafts.length < 1 ||
      value.drafts.length > 100
    )
      return null
    const weeks = planWeekCount(value.query)
    const ids = new Set<number>()
    for (const draft of value.drafts) {
      if (
        !draft ||
        !Number.isInteger(draft.id) ||
        draft.id < 1 ||
        draft.id > 2_147_483_647 ||
        ids.has(draft.id) ||
        typeof draft.name !== 'string' ||
        !draft.name.trim() ||
        draft.name.length > 1000 ||
        !validHours(draft.weeklyHours) ||
        !validHours(draft.expectedWeeklyHours) ||
        !Array.isArray(draft.allocatedHours) ||
        draft.allocatedHours.length !== weeks ||
        !draft.allocatedHours.every(
          (hours) =>
            typeof hours === 'number' &&
            Number.isFinite(hours) &&
            hours >= 0 &&
            hours <= Number.MAX_SAFE_INTEGER,
        )
      )
        return null
      ids.add(draft.id)
    }
    return value
  } catch {
    return null
  }
}

function pointer(): string | null {
  try {
    return sessionStorage.getItem(POINTER_KEY)
  } catch {
    return null
  }
}

function setPointer(id: string | null) {
  try {
    if (id) sessionStorage.setItem(POINTER_KEY, id)
    else sessionStorage.removeItem(POINTER_KEY)
  } catch {
    /* Local recovery can still work when session storage is blocked. */
  }
}

export function readRecovery(): {
  plan: SavedPlan | null
  warning: string | null
} {
  try {
    const ownedId = pointer()
    const records: SavedPlan[] = []
    // Collect keys first: cleanup changes Storage.length and its key indices.
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    for (const key of keys) {
      if (!key) continue
      if (key.startsWith(CONSUMED_PREFIX)) {
        if (Number(localStorage.getItem(key)) <= Date.now()) localStorage.removeItem(key)
        continue
      }
      if (!key.startsWith(PLAN_PREFIX)) continue
      const record = decodeSavedPlan(localStorage.getItem(key) ?? '')
      if (!record || key !== PLAN_PREFIX + record.id) {
        localStorage.removeItem(key)
        continue
      }
      // A duplicate tab can keep its own backup even if another tab restored a copy.
      if (
        record.id === ownedId ||
        !localStorage.getItem(CONSUMED_PREFIX + record.id + ':' + record.revision)
      )
        records.push(record)
    }
    records.sort(
      (a, b) => Number(b.id === ownedId) - Number(a.id === ownedId) || b.savedAt - a.savedAt,
    )
    return { plan: records[0] ?? null, warning: null }
  } catch {
    return { plan: null, warning: recoveryUnavailable }
  }
}

export function savePlan(record: SavedPlan): string | null {
  try {
    const encoded = JSON.stringify(record)
    if (encoded.length > MAX_BYTES) return recoveryUnavailable
    localStorage.setItem(PLAN_PREFIX + record.id, encoded)
    setPointer(record.id)
    return null
  } catch {
    return recoveryUnavailable
  }
}

export function clearPlan(id: string): string | null {
  try {
    localStorage.removeItem(PLAN_PREFIX + id)
    if (pointer() === id) setPointer(null)
    return null
  } catch {
    return recoveryUnavailable
  }
}

// Consume an exact revision, not the source record. Restoring always forks into
// a fresh key, so a live or duplicated tab's original backup remains untouched.
export function consumeRecovery(record: SavedPlan): string | null {
  try {
    localStorage.setItem(
      CONSUMED_PREFIX + record.id + ':' + record.revision,
      String(record.expiresAt),
    )
    if (pointer() === record.id) setPointer(null)
    return null
  } catch {
    return recoveryUnavailable
  }
}
