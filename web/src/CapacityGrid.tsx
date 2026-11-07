import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { dateLabel, dateRangeLabel, hours, shiftDate, type Query, type Person } from './capacity'
import { useCapacity } from './useCapacity'
import { CapacityEditor } from './CapacityEditor'
import { AllocationCell } from './AllocationCell'
import { AllocationDetails } from './AllocationDetails'
import { useCapacityPlan } from './useCapacityPlan'
import { CapacityPlanPanel } from './CapacityPlanPanel'
import { PlanRecovery } from './PlanRecovery'

type Props = { from: string; to: string }

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5.5" />
      <path d="m13 13 4 4" />
    </svg>
  )
}

export function CapacityGrid({ from, to }: Props) {
  // Applied query state is separate from form drafts: typing never changes the grid.
  const [query, setQuery] = useState<Query>({
    from,
    to,
    offset: 0,
    search: '',
    status: 'all',
    sort: 'name',
  })
  const [range, setRange] = useState({ from, to })
  const [search, setSearch] = useState('')
  const [rangeError, setRangeError] = useState('')
  const [customDates, setCustomDates] = useState(false)
  const customDateTrigger = useRef<HTMLButtonElement>(null)

  const [editingId, setEditingId] = useState<number | null>(null)
  const [mobileWeek, setMobileWeek] = useState(0)
  const [details, setDetails] = useState<{
    personId: number
    personName: string
    week: string
  } | null>(null)
  const { data, loading, error, savingId, savePerson, reload } = useCapacity(query)

  // Reloads can remove the edited row, so focus needs a stable fallback destination.
  const gridPanel = useRef<HTMLDivElement>(null)
  const retryButton = useRef<HTMLButtonElement>(null)
  const focusAfterReload = useRef<number | null>(null)
  const planTrigger = useRef<HTMLButtonElement>(null)
  const focusAfterPlan = useRef(false)
  const focusOnPlanStart = useRef(false)

  function refreshAfterPlan() {
    focusAfterReload.current = null
    focusAfterPlan.current = true
    reload()
  }

  const plan = useCapacityPlan({
    query,
    onApplied: refreshAfterPlan,
    onReconcile: refreshAfterPlan,
    onRestoreQuery: (restored) => {
      // Recovered allocation arrays belong to their saved date horizon.
      setQuery(restored)
      setRange({ from: restored.from, to: restored.to })
      setSearch(restored.search ?? '')
      setRangeError('')
      setCustomDates(false)
      setDetails(null)
      setEditingId(null)
      focusAfterPlan.current = false
      focusOnPlanStart.current = true
      reload()
    },
  })

  useEffect(() => {
    if (loading) return
    if (focusAfterPlan.current && !plan.active) {
      if (error) {
        retryButton.current?.focus()
        return
      }
      planTrigger.current?.focus()
      focusAfterPlan.current = false
    }
    if (focusOnPlanStart.current && plan.active) {
      const firstEditor =
        gridPanel.current?.querySelector<HTMLButtonElement>('button[data-person-id]')
      if (firstEditor) firstEditor.focus()
      else document.getElementById('people-search')?.focus()
      focusOnPlanStart.current = false
    }
  }, [data, loading, error, plan.active])

  function startPlanning() {
    plan.start()
    focusOnPlanStart.current = true
  }

  useEffect(() => {
    if (focusAfterReload.current === null || loading) return
    if (error) {
      retryButton.current?.focus()
      return
    }
    const button = gridPanel.current?.querySelector<HTMLButtonElement>(
      `button[data-person-id="${focusAfterReload.current}"]`,
    )
    if (button) button.focus()
    else if (data) gridPanel.current?.focus()
    if (button || data) focusAfterReload.current = null
  }, [data, loading, error])

  useEffect(() => {
    setMobileWeek(0)
  }, [query.from, query.to])

  // A save or another manager can shrink the last page without emptying the roster.
  useEffect(() => {
    if (!loading && data && query.offset > 0 && data.people.length === 0 && data.total > 0) {
      focusAfterReload.current ??= -1
      setQuery((current) => ({
        ...current,
        offset: Math.floor((data.total - 1) / 50) * 50,
      }))
    }
  }, [loading, data, query.offset])

  function reconcile(id: number) {
    focusAfterReload.current = id
    reload()
  }

  function openDetails(person: Person) {
    if (!data) return
    // Discovery remains anchored to saved work while the grid previews draft limits.
    const baseline = savedById.get(person.id) ?? person
    const overloaded = baseline.allocatedHours.findIndex((value) => value > baseline.weeklyHours)
    const allocated = baseline.allocatedHours.findIndex((value) => value > 0)
    const index = window.matchMedia('(max-width: 680px)').matches
      ? mobileWeek
      : overloaded >= 0
        ? overloaded
        : Math.max(0, allocated)
    const week = data.weeks[Math.min(index, data.weeks.length - 1)].start
    setDetails({ personId: person.id, personName: person.name, week })
  }

  const busy = savingId !== null || plan.applying || plan.restoring
  const viewLocked = busy || editingId !== null
  const dateLocked = viewLocked || plan.active

  // Keep saved metrics authoritative; only rows and scenario impact use draft limits.
  const savedById = new Map(data?.people.map((person) => [person.id, person]) ?? [])
  const displayedPeople = data?.people.map(plan.project) ?? []
  const draftedIds = new Set(
    displayedPeople
      .filter((person) => person.weeklyHours !== savedById.get(person.id)?.weeklyHours)
      .map((person) => person.id),
  )
  const projectedPageOverCount = displayedPeople.filter((person) =>
    person.allocatedHours.some((value) => value > person.weeklyHours),
  ).length
  const pageOverCount =
    data?.people.filter((person) =>
      person.allocatedHours.some((value) => value > person.weeklyHours),
    ).length ?? 0
  const pageAllocated =
    data?.people.reduce(
      (sum, person) => sum + person.allocatedHours.reduce((a, b) => a + b, 0),
      0,
    ) ?? 0
  const pageAvailable =
    data?.people.reduce(
      (sum, person) =>
        sum +
        person.allocatedHours.reduce(
          (total, value) => total + Math.max(0, person.weeklyHours - value),
          0,
        ),
      0,
    ) ?? 0
  const globalSummary = data?.summary
  const summaryPeople = globalSummary?.people ?? data?.people.length
  const overCount = globalSummary?.overCapacityPeople ?? pageOverCount
  const allocated = globalSummary?.allocatedHours ?? pageAllocated
  const available = globalSummary?.availableHours ?? pageAvailable

  async function saveCapacity(id: number, value: number, expected: number) {
    if (plan.active) {
      const savedPerson = savedById.get(id)
      if (!savedPerson) throw new Error('Reload this person before staging a capacity change.')
      await plan.stage(savedPerson, value)
      return
    }
    await savePerson(id, value, expected)
    if (query.status === 'over' || query.sort === 'overload') focusAfterReload.current = id
  }

  function applyRange(event: FormEvent) {
    event.preventDefault()
    if (!range.from || !range.to || range.from > range.to) {
      setRangeError('Choose an end date on or after the start date.')
      return
    }
    if ((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 > 735) {
      setRangeError('Choose a range of up to 2 years.')
      return
    }
    setRangeError('')
    customDateTrigger.current?.focus()
    setCustomDates(false)
    setQuery((current) => ({ ...current, ...range, offset: 0 }))
  }

  function navigate(days: number) {
    const next = {
      from: shiftDate(query.from, days),
      to: shiftDate(query.to, days),
    }
    setRange(next)
    setRangeError('')
    setQuery((current) => ({ ...current, ...next, offset: 0 }))
  }

  function chooseWeeks(count: number) {
    const weekday = new Date(`${query.from}T12:00:00Z`).getUTCDay()
    const start = shiftDate(query.from, -((weekday + 6) % 7))
    const next = { from: start, to: shiftDate(start, count * 7 - 1) }
    setRange(next)
    setRangeError('')
    setQuery((current) => ({ ...current, ...next, offset: 0 }))
  }

  function applySearch(event: FormEvent) {
    event.preventDefault()
    setQuery((current) => ({ ...current, search: search.trim(), offset: 0 }))
  }

  function clearSearch() {
    setSearch('')
    setQuery((current) => ({ ...current, search: '', offset: 0 }))
  }

  function resetView() {
    setSearch('')
    setRange({ from, to })
    setRangeError('')
    setQuery({ from, to, offset: 0, search: '', status: 'all', sort: 'name' })
  }

  const currentMobileWeek = data?.weeks[Math.min(mobileWeek, data.weeks.length - 1)]

  return (
    <section aria-label="Team capacity planning">
      <div className="workspace-heading">
        <div>
          <h1>
            Team capacity<span className="title-dot">.</span>
          </h1>
          <p className="intro">Compare allocation with capacity, week by week.</p>
        </div>
        <div className="heading-tools">
          <div className="legend">
            <span>
              <i className="legend-dot available" />
              Within capacity
            </span>
            <span>
              <i className="legend-dot overload" />
              Over capacity
            </span>
          </div>
          <button
            ref={planTrigger}
            className="primary-button plan-start-button"
            type="button"
            disabled={viewLocked || loading || plan.active || !!plan.recovery || !data}
            onClick={startPlanning}
          >
            Plan capacity
          </button>
        </div>
      </div>
      <div className="planning-controls">
        <div className="toolbar">
          <div className="range-navigation">
            <div className="week-navigation" aria-label="Week navigation">
              <button
                className="icon-button"
                disabled={dateLocked}
                onClick={() => navigate(-7)}
                aria-label="Previous week"
              >
                ←
              </button>
              <button
                className="icon-button"
                disabled={dateLocked}
                onClick={() => navigate(7)}
                aria-label="Next week"
              >
                →
              </button>
            </div>
            <div className="date-range-title">
              {data ? dateRangeLabel(data.from, data.to) : 'Weekly allocation'}
            </div>
          </div>
          <div className="range-presets" aria-label="Date range presets">
            {[3, 6, 12].map((count) => (
              <button
                key={count}
                type="button"
                disabled={dateLocked}
                className={data?.weeks.length === count ? 'active' : ''}
                aria-pressed={data?.weeks.length === count}
                onClick={() => chooseWeeks(count)}
              >
                {count} weeks
              </button>
            ))}
          </div>
          <button
            ref={customDateTrigger}
            className="text-button custom-dates-button"
            type="button"
            disabled={dateLocked}
            aria-expanded={customDates}
            aria-controls="custom-date-panel"
            onClick={() => setCustomDates((current) => !current)}
          >
            Custom dates
          </button>
          <button className="text-button reset-button" disabled={dateLocked} onClick={resetView}>
            Reset view
          </button>
        </div>
        {customDates && (
          <div className="custom-date-panel" id="custom-date-panel">
            {' '}
            <form className="range-form" onSubmit={applyRange}>
              <label>
                From
                <input
                  type="date"
                  value={range.from}
                  disabled={dateLocked}
                  required
                  onChange={(event) =>
                    setRange((current) => ({
                      ...current,
                      from: event.target.value,
                    }))
                  }
                />
              </label>
              <span className="range-dash" aria-hidden="true">
                →
              </span>
              <label>
                To
                <input
                  type="date"
                  value={range.to}
                  disabled={dateLocked}
                  required
                  onChange={(event) =>
                    setRange((current) => ({
                      ...current,
                      to: event.target.value,
                    }))
                  }
                />
              </label>
              <button className="primary-button" disabled={dateLocked} type="submit">
                Apply range
              </button>
            </form>
          </div>
        )}
        <div className="priority-controls">
          <form className="people-search" onSubmit={applySearch}>
            <SearchIcon />
            <label className="sr-only" htmlFor="people-search">
              Search people
            </label>
            <input
              id="people-search"
              type="search"
              placeholder="Find a team member…"
              maxLength={100}
              value={search}
              disabled={viewLocked}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button className="search-button" disabled={viewLocked} type="submit">
              Search
            </button>
            {query.search && (
              <button
                className="clear-search"
                disabled={viewLocked}
                type="button"
                aria-label="Clear search"
                onClick={clearSearch}
              >
                ×
              </button>
            )}
          </form>
          <button
            type="button"
            className={`priority-toggle ${query.status === 'over' ? 'active' : ''}`}
            aria-pressed={query.status === 'over'}
            disabled={viewLocked}
            onClick={() =>
              setQuery((current) => ({
                ...current,
                status: current.status === 'over' ? 'all' : 'over',
                offset: 0,
              }))
            }
          >
            <span className="priority-dot" aria-hidden="true" />
            Over capacity only
          </button>
          <label className="sort-control">
            Sort people
            <select
              aria-label="Sort people"
              value={query.sort ?? 'name'}
              disabled={viewLocked}
              onChange={(event) =>
                setQuery((current) => ({
                  ...current,
                  sort: event.target.value as 'name' | 'overload',
                  offset: 0,
                }))
              }
            >
              <option value="name">Name</option>
              <option value="overload">Highest overload</option>
            </select>
          </label>
          <span className="priority-scope">
            {plan.active
              ? 'Filters and order use saved capacities'
              : 'Across the whole matching roster'}
          </span>
        </div>
      </div>
      {rangeError && (
        <p role="alert" className="range-error">
          {rangeError}
        </p>
      )}
      <PlanRecovery plan={plan} disabled={viewLocked} />
      <CapacityPlanPanel plan={plan} disabled={editingId !== null} />
      <p className="summary-context">
        {globalSummary ? 'Saved roster summary' : 'Saved page summary'} · all{' '}
        {data ? data.weeks.length : 'selected'} weeks · {data ? summaryPeople : '—'}{' '}
        {globalSummary ? 'matching people' : 'people on this page'}
      </p>
      <div
        className="page-summary"
        aria-label={
          globalSummary
            ? 'Saved summary of all matching people'
            : 'Saved summary of people on this page'
        }
      >
        <div className="summary-scope">
          <strong>{data ? summaryPeople : '—'}</strong>
          <span>
            {globalSummary ? 'matching people' : 'people shown'}
            <small>
              {query.search
                ? `Matching “${query.search}”`
                : globalSummary
                  ? 'Entire matching roster'
                  : 'Current roster page'}
            </small>
          </span>
        </div>
        <div className="summary-stat attention">
          <strong>{data ? overCount : '—'}</strong>
          <span>
            over capacity<small>At least one week in range</small>
          </span>
        </div>
        <div className="summary-stat">
          <strong>
            {data ? hours(allocated) : '—'}
            <em>h</em>
          </strong>
          <span>
            allocated
            <small>
              {globalSummary
                ? 'Matching roster · full range'
                : 'Shown people · full selected range'}
            </small>
          </span>
        </div>
        <div className="summary-stat">
          <strong>
            {data ? hours(available) : '—'}
            <em>h</em>
          </strong>
          <span>
            room to plan
            <small>
              {globalSummary
                ? 'Matching roster · full range'
                : 'Shown people · full selected range'}
            </small>
          </span>
        </div>
      </div>
      <div className="grid-context">
        <div>
          <span className="grid-title">
            {plan.active ? 'Scenario preview' : 'Weekly allocation'}
          </span>
          <span className="grid-context-note">
            {data
              ? `${data.weeks.length} ${data.weeks.length === 1 ? 'week' : 'weeks'} · ${data.total} ${query.search ? 'matching people' : 'people'}`
              : loading
                ? 'Loading your team…'
                : 'Capacity unavailable'}
          </span>
        </div>
        <span className="edit-instruction">
          {plan.active ? 'Edit weekly capacity to stage changes' : 'Select weekly capacity to edit'}{' '}
          <span aria-hidden="true">↗</span>
        </span>
      </div>
      {data && (
        <div className="mobile-week-picker" aria-label="Displayed week">
          <button
            className="icon-button"
            type="button"
            aria-label="Earlier displayed week"
            disabled={viewLocked || mobileWeek === 0}
            onClick={() => setMobileWeek((index) => Math.max(0, index - 1))}
          >
            ←
          </button>
          <span>
            <small>
              SHOWING WEEK {mobileWeek + 1} OF {data.weeks.length}
            </small>
            <strong>
              {currentMobileWeek
                ? dateRangeLabel(currentMobileWeek.start, currentMobileWeek.end)
                : ''}
            </strong>
          </span>
          <button
            className="icon-button"
            type="button"
            aria-label="Later displayed week"
            disabled={viewLocked || mobileWeek >= data.weeks.length - 1}
            onClick={() => setMobileWeek((index) => Math.min(data.weeks.length - 1, index + 1))}
          >
            →
          </button>
        </div>
      )}
      <div ref={gridPanel} className="grid-panel" tabIndex={-1} aria-busy={loading}>
        {loading ? (
          <div className="grid-loading" role="status">
            <span className="loading-dot" />
            Loading capacity…
            <div className="skeleton-lines" aria-hidden="true">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} />
              ))}
            </div>
          </div>
        ) : error ? (
          <div className="grid-error" role="alert">
            <span className="state-icon">!</span>
            <h2>Capacity couldn’t be loaded</h2>
            <p>{error}</p>
            <button ref={retryButton} className="primary-button" onClick={reload}>
              Try again
            </button>
          </div>
        ) : data && data.people.length > 0 ? (
          <div className="table-scroll" tabIndex={0} aria-label="Scrollable capacity grid">
            <table style={{ '--week-count': data.weeks.length } as CSSProperties}>
              <caption className="sr-only">
                Allocated hours against recurring weekly capacity. Weeks start on Monday;
                allocations count weekdays.
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="person-column">
                    Team member{' '}
                    <span className="column-detail">
                      {query.sort === 'overload' ? 'BY OVERLOAD' : 'A–Z'}
                    </span>
                  </th>
                  <th scope="col" className="capacity-column">
                    Weekly capacity<span>Recurring limit</span>
                  </th>
                  {data.weeks.map((week, index) => (
                    <th
                      scope="col"
                      key={week.start}
                      className={`week-column ${index === mobileWeek ? 'mobile-active' : ''}`}
                    >
                      <span className="week-kicker">
                        WEEK {index + 1} <span>{dateLabel(week.start, { year: 'numeric' })}</span>
                      </span>
                      <strong>
                        {dateLabel(week.start)}
                        <span className="week-end"> – {dateLabel(week.end)}</span>
                      </strong>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayedPeople.map((person) => (
                  <tr
                    key={person.id}
                    className={draftedIds.has(person.id) ? 'scenario-row' : undefined}
                  >
                    <th scope="row" className="person-column">
                      <span className="person-cell">
                        <span className="avatar" aria-hidden="true">
                          {person.name
                            .split(' ')
                            .map((part) => part[0])
                            .slice(0, 2)
                            .join('')}
                        </span>
                        <button
                          className="person-details-button"
                          disabled={viewLocked}
                          onClick={() => openDetails(person)}
                          aria-label={`View allocation details for ${person.name}`}
                        >
                          {person.name}
                        </button>
                      </span>
                    </th>
                    <td className="capacity-column">
                      <CapacityEditor
                        person={person}
                        busy={
                          busy || plan.uncertain || (editingId !== null && editingId !== person.id)
                        }
                        save={saveCapacity}
                        saveLabel={plan.active ? 'Stage change' : 'Save'}
                        successLabel={
                          plan.active ? (draftedIds.has(person.id) ? 'Drafted' : '') : 'Saved'
                        }
                        onEditing={setEditingId}
                        onReconcile={reconcile}
                      />
                    </td>
                    {data.weeks.map((week, index) => (
                      <td
                        key={week.start}
                        className={`week-cell ${index === mobileWeek ? 'mobile-active' : ''}`}
                        aria-label={`${person.name}, week of ${week.start}: ${hours(person.allocatedHours[index])} hours allocated, ${hours(person.weeklyHours)} hours capacity${draftedIds.has(person.id) ? ', draft capacity' : ''}`}
                      >
                        <AllocationCell
                          allocated={person.allocatedHours[index]}
                          capacity={person.weeklyHours}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="grid-error">
            <span className="state-icon">
              <SearchIcon />
            </span>
            <h2>
              {data && data.total > 0
                ? 'Returning to the last page…'
                : query.status === 'over'
                  ? query.search
                    ? 'No team members match this view'
                    : 'Everyone is within capacity'
                  : query.search
                    ? 'No matching team members'
                    : 'No people to show'}
            </h2>
            <p>
              {data && data.total > 0
                ? 'The matching roster changed. Loading its last available page.'
                : query.status === 'over'
                  ? query.search
                    ? `No people matching “${query.search}” are over capacity in this range.`
                    : 'No one is over capacity in the selected date range.'
                  : query.search
                    ? `No names match “${query.search}”. Try a different name or clear your search.`
                    : 'The roster is empty for this page.'}
            </p>
            <button
              className="primary-button"
              onClick={
                query.status === 'over'
                  ? () =>
                      setQuery((current) => ({
                        ...current,
                        status: 'all',
                        offset: 0,
                      }))
                  : query.search
                    ? clearSearch
                    : () => setQuery((current) => ({ ...current, offset: 0 }))
              }
            >
              {query.status === 'over'
                ? 'Show all capacities'
                : query.search
                  ? 'Show everyone'
                  : 'Back to first page'}
            </button>
          </div>
        )}
      </div>
      <div className="grid-footer">
        <p>
          {data ? (
            <>
              {plan.active && 'Preview: '}
              <strong>{plan.active ? projectedPageOverCount : pageOverCount}</strong>{' '}
              {(plan.active ? projectedPageOverCount : pageOverCount) === 1 ? 'person' : 'people'}{' '}
              over capacity on this page
            </>
          ) : (
            'Allocation is measured in hours, Monday to Friday.'
          )}
        </p>
        <div className="pagination">
          <span>
            {data
              ? `${query.offset + (data.people.length ? 1 : 0)}–${query.offset + data.people.length} of ${data.total}`
              : '—'}
          </span>
          <button
            className="icon-button"
            aria-label="Previous people"
            disabled={viewLocked || loading || query.offset === 0}
            onClick={() =>
              setQuery((current) => ({
                ...current,
                offset: Math.max(0, current.offset - 50),
              }))
            }
          >
            ←
          </button>
          <button
            className="icon-button"
            aria-label="Next people"
            disabled={
              viewLocked || loading || !data || query.offset + data.people.length >= data.total
            }
            onClick={() =>
              setQuery((current) => ({
                ...current,
                offset: current.offset + 50,
              }))
            }
          >
            →
          </button>
        </div>
      </div>
      <p className="scope-note">
        <span aria-hidden="true">↳</span> Capacity is a person’s recurring weekly limit. Changing it
        updates every week.
      </p>
      {details && (
        <AllocationDetails
          {...details}
          planning={plan.active}
          draftWeeklyHours={plan.drafts.find((draft) => draft.id === details.personId)?.weeklyHours}
          onClose={() => setDetails(null)}
        />
      )}
    </section>
  )
}
