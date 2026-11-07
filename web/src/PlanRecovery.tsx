import { dateRangeLabel } from './capacity'
import type { CapacityPlan } from './useCapacityPlan'
import './PlanRecovery.css'

export function PlanRecovery({
  plan,
  disabled = false,
}: {
  plan: CapacityPlan
  disabled?: boolean
}) {
  // Recovery is an explicit decision; it must never replace an active draft.
  const recovery = plan.active ? null : plan.recovery

  if (!recovery && !plan.storageWarning && !plan.recoveryError) return null

  return (
    <section className="plan-recovery" aria-label="Saved capacity draft">
      {recovery && (
        <>
          <div className="plan-recovery-heading">
            <div>
              <p className="plan-recovery-kicker">SAVED IN THIS BROWSER</p>
              <h2>Resume your capacity draft</h2>
              <p>
                {recovery.drafts.length} {recovery.drafts.length === 1 ? 'person' : 'people'}{' '}
                planned · {dateRangeLabel(recovery.query.from, recovery.query.to)}
              </p>
            </div>

            <div className="plan-recovery-actions">
              <button
                type="button"
                className="plan-recovery-discard"
                disabled={disabled || plan.restoring}
                onClick={plan.discardRecovery}
              >
                Discard saved draft
              </button>
              <button
                type="button"
                className="plan-recovery-restore"
                disabled={disabled || plan.restoring}
                onClick={() => void plan.restore()}
              >
                {plan.restoring ? 'Restoring draft…' : 'Restore draft'}
              </button>
            </div>
          </div>

          <p className="plan-recovery-explanation" role="status">
            {recovery.uncertain
              ? 'An earlier apply was not confirmed and may have reached the server. Restore keeps its original changes for a safe retry or refresh.'
              : 'Restore checks the latest saved capacities before you review and apply. Restoring does not save changes.'}
          </p>
        </>
      )}

      {plan.recoveryError && (
        <p className="plan-recovery-error" role="alert">
          {plan.recoveryError}
        </p>
      )}

      {plan.storageWarning && (
        <p className="plan-recovery-warning" role="status">
          {plan.storageWarning}
        </p>
      )}
    </section>
  )
}
