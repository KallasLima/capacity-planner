import { useEffect, useId, useRef, useState } from 'react'
import { dateRangeLabel, hours, readResponse, shiftDate } from './capacity'
import './AllocationDetails.css'

type Props = {
  personId: number
  personName: string
  week: string
  onClose: () => void
  planning?: boolean
  draftWeeklyHours?: number
}

type AllocationBreakdown = {
  person: { id: number; name: string; weeklyHours: number }
  week: { start: string; end: string }
  allocatedHours: number
  projects: {
    id: number
    name: string
    hours: number
    assignmentCount: number
  }[]
}

type Snapshot = {
  key: string
  data: AllocationBreakdown | null
  error: string | null
}

export function AllocationDetails({
  personId,
  personName,
  week,
  onClose,
  planning = false,
  draftWeeklyHours,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const weekId = useId()
  const request = useRef(0)
  const [selectedWeek, setSelectedWeek] = useState(week)
  const [revision, setRevision] = useState(0)
  const [snapshot, setSnapshot] = useState<Snapshot>({
    key: '',
    data: null,
    error: null,
  })

  // Hide the previous week's values immediately while the next request is pending.
  const key = `${personId}/${selectedWeek}/${revision}`
  const data = snapshot.key === key ? snapshot.data : null
  const error = snapshot.key === key ? snapshot.error : null
  const loading = !data && !error

  useEffect(() => {
    setSelectedWeek(week)
  }, [personId, week])

  useEffect(() => {
    // Native modal behavior supplies focus trapping, Escape, and opener restoration.
    const element = dialog.current
    element?.showModal()
    return () => {
      element?.close()
    }
  }, [])

  useEffect(() => {
    // Abort saves work; the sequence check also rejects late responses after navigation.
    const sequence = ++request.current
    const controller = new AbortController()
    let disposed = false
    const timeout = window.setTimeout(() => controller.abort(), 15_000)
    setSnapshot({ key, data: null, error: null })
    const params = new URLSearchParams({ week: selectedWeek })
    fetch(`/api/people/${personId}/allocations?${params}`, {
      signal: controller.signal,
    })
      .then(readResponse<AllocationBreakdown>)
      .then((result) => {
        if (!disposed && sequence === request.current)
          setSnapshot({ key, data: result, error: null })
      })
      .catch((cause: unknown) => {
        if (disposed || sequence !== request.current) return
        setSnapshot({
          key,
          data: null,
          error: controller.signal.aborted
            ? 'The request took too long. Please try again.'
            : cause instanceof Error
              ? cause.message
              : 'Could not load allocation details.',
        })
      })
      .finally(() => window.clearTimeout(timeout))

    return () => {
      disposed = true
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [key, personId, selectedWeek])

  const rangeLabel = dateRangeLabel(selectedWeek, shiftDate(selectedWeek, 6))
  const overage = data ? Math.max(0, data.allocatedHours - data.person.weeklyHours) : 0
  const available = data ? Math.max(0, data.person.weeklyHours - data.allocatedHours) : 0

  function dismiss() {
    dialog.current?.close()
    onClose()
  }

  return (
    <dialog
      ref={dialog}
      className="allocation-details"
      aria-labelledby={titleId}
      aria-describedby={weekId}
      onCancel={(event) => {
        event.preventDefault()
        dismiss()
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          dismiss()
      }}
    >
      <header className="allocation-details-header">
        <div>
          <p className="allocation-details-eyebrow">Weekly allocation</p>
          <h2 id={titleId}>{personName}</h2>
        </div>
        <button
          className="allocation-details-close"
          type="button"
          aria-label="Close allocation details"
          onClick={dismiss}
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="m5 5 10 10M15 5 5 15" />
          </svg>
        </button>
      </header>

      <div className="allocation-details-week-nav">
        <button
          type="button"
          aria-label="Previous detail week"
          onClick={() => setSelectedWeek((current) => shiftDate(current, -7))}
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="m12 5-5 5 5 5" />
          </svg>
        </button>
        <p id={weekId}>{rangeLabel}</p>
        <button
          type="button"
          aria-label="Next detail week"
          onClick={() => setSelectedWeek((current) => shiftDate(current, 7))}
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="m8 5 5 5-5 5" />
          </svg>
        </button>
      </div>

      <div className="allocation-details-content" aria-busy={loading}>
        {loading && (
          <div className="allocation-details-loading" role="status">
            <span className="allocation-details-loading-dot" aria-hidden="true" />
            Loading weekly allocation…
          </div>
        )}
        {error && (
          <div className="allocation-details-error" role="alert">
            <h3>Allocation details unavailable</h3>
            <p>{error}</p>
            <button type="button" onClick={() => setRevision((value) => value + 1)}>
              Retry
            </button>
          </div>
        )}
        {data && (
          <>
            <section
              className={`allocation-details-summary${overage > 0 ? ' allocation-details-summary-over' : ''}`}
              aria-label="Weekly allocation totals"
            >
              <p className="allocation-details-summary-label">Allocated this week</p>
              <p className="allocation-details-total">
                {hours(data.allocatedHours)}
                <span> h</span>
              </p>
              <p className="allocation-details-capacity">
                of {hours(data.person.weeklyHours)} h{' '}
                {planning ? 'saved weekly capacity' : 'weekly capacity'}
              </p>
              {planning && (
                <p className="allocation-details-draft-context">
                  {draftWeeklyHours === undefined ? (
                    'No staged capacity change for this person.'
                  ) : (
                    <>
                      Draft limit: <strong>{hours(draftWeeklyHours)} h / week</strong>
                      {' · '}preview
                    </>
                  )}
                </p>
              )}
              <div className="allocation-details-capacity-track" aria-hidden="true">
                <span
                  style={{
                    width: `${data.person.weeklyHours > 0 ? Math.min(100, (data.allocatedHours / data.person.weeklyHours) * 100) : data.allocatedHours > 0 ? 100 : 0}%`,
                  }}
                />
              </div>
              <p className="allocation-details-balance">
                {overage > 0
                  ? `${hours(overage)} h over capacity`
                  : available > 0
                    ? `${hours(available)} h available`
                    : 'At capacity'}
              </p>
            </section>

            <section
              className="allocation-details-projects"
              aria-labelledby={`${titleId}-projects`}
            >
              <div className="allocation-details-section-title">
                <h3 id={`${titleId}-projects`}>Project breakdown</h3>
                <span>
                  {data.projects.length} {data.projects.length === 1 ? 'project' : 'projects'}
                </span>
              </div>
              {data.projects.length === 0 ? (
                <div className="allocation-details-empty">
                  <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
                    <rect x="5" y="7" width="22" height="20" rx="3" />
                    <path d="M11 4v6M21 4v6M5 14h22M12 20h8" />
                  </svg>
                  <h4>No allocations this week</h4>
                  <p>There are no project hours assigned to {personName} for this week.</p>
                </div>
              ) : (
                <>
                  <p className="allocation-details-project-intro">
                    Each bar shows its share of allocated hours.
                  </p>
                  <ul className="allocation-details-project-list">
                    {data.projects.map((project) => (
                      <li key={project.id}>
                        <div className="allocation-details-project-heading">
                          <h4>{project.name}</h4>
                          <p>
                            {hours(project.hours)}
                            <span> h</span>
                          </p>
                        </div>
                        <div className="allocation-details-project-track" aria-hidden="true">
                          <span
                            style={{
                              width: `${data.allocatedHours > 0 ? Math.min(100, (project.hours / data.allocatedHours) * 100) : 0}%`,
                            }}
                          />
                        </div>
                        <p className="allocation-details-assignment-count">
                          {project.assignmentCount}{' '}
                          {project.assignmentCount === 1 ? 'assignment' : 'assignments'}
                        </p>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          </>
        )}
      </div>
    </dialog>
  )
}
