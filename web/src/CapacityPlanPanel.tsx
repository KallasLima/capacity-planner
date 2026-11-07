import { hours } from './capacity'
import type { CapacityPlan } from './useCapacityPlan'
import './CapacityPlanPanel.css'

export function CapacityPlanPanel({
  plan,
  disabled = false,
}: {
  plan: CapacityPlan
  disabled?: boolean
}) {
  if (!plan.active) return null

  // Impact compares the saved baseline with proposed limits for planned people
  // and the locked date range, independently of the currently visible roster page.
  const before = plan.drafts.reduce(
    (sum, draft) =>
      sum + draft.allocatedHours.filter((value) => value > draft.expectedWeeklyHours).length,
    0,
  )

  const after = plan.drafts.reduce(
    (sum, draft) => sum + draft.allocatedHours.filter((value) => value > draft.weeklyHours).length,
    0,
  )

  const delta = plan.drafts.reduce(
    (sum, draft) => sum + draft.weeklyHours - draft.expectedWeeklyHours,
    0,
  )

  return (
    <section className="capacity-plan" aria-label="Capacity scenario">
      <div className="capacity-plan-heading">
        <div>
          <span className="capacity-plan-badge">DRAFT ONLY</span>
          <h2>Capacity scenario</h2>
          <p>
            Preview recurring limits against loaded project allocations. Apply saves every change
            together.
          </p>
        </div>
        <div className="capacity-plan-actions">
          <button
            type="button"
            className="capacity-plan-discard"
            disabled={plan.applying || disabled}
            onClick={plan.discard}
          >
            {plan.uncertain ? 'Close and refresh' : 'Discard plan'}
          </button>
          <button
            type="button"
            className="capacity-plan-apply"
            disabled={plan.applying || disabled || !plan.drafts.length}
            onClick={plan.apply}
          >
            {plan.applying
              ? 'Applying plan…'
              : plan.reviewedConflict
                ? 'Apply reviewed plan'
                : 'Apply plan'}
          </button>
        </div>
      </div>
      {plan.error && (
        <p className="capacity-plan-error" role="alert">
          {plan.error}
        </p>
      )}
      {plan.drafts.length ? (
        <>
          <div className="capacity-plan-impact">
            <strong>
              {plan.drafts.length} {plan.drafts.length === 1 ? 'person' : 'people'} changed
            </strong>
            <span>
              Weekly capacity: {delta >= 0 ? '+' : ''}
              {hours(delta)} h
            </span>
            <span>
              Overloaded person-weeks: {before} → {after}
            </span>
            <small>Impact covers planned people and the selected range.</small>
          </div>
          <ul className="capacity-plan-changes">
            {plan.drafts.map((draft) => (
              <li key={draft.id}>
                <strong>{draft.name}</strong>
                <span>
                  {hours(draft.expectedWeeklyHours)} → <b>{hours(draft.weeklyHours)} h / week</b>
                </span>
                <button
                  type="button"
                  aria-label={`Remove change for ${draft.name}`}
                  disabled={plan.applying || disabled || plan.uncertain}
                  onClick={() => plan.remove(draft.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="capacity-plan-empty">
          Edit weekly capacity in the grid to stage a change. Your saved roster remains unchanged
          until you apply.
        </p>
      )}
    </section>
  )
}
