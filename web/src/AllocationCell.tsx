import { hours } from './capacity'
import './AllocationCell.css'

export function AllocationCell({ allocated, capacity }: { allocated: number; capacity: number }) {
  const over = allocated > capacity

  // Clamp only the visual meter. The numeric ratio preserves the full overload,
  // including allocated work against a zero-capacity person.
  const percentage =
    capacity > 0 ? Math.min(100, (allocated / capacity) * 100) : allocated > 0 ? 100 : 0

  // Routine headroom stays secondary; the visible caption is reserved for overloads.
  const detail = over
    ? `${hours(allocated - capacity)} h over capacity`
    : allocated === 0
      ? 'No allocation'
      : `${hours(capacity - allocated)} h available`

  return (
    <div
      className={`allocation compact-allocation ${over ? 'over' : allocated === 0 ? 'unallocated' : ''}`}
      title={detail}
    >
      <div className="allocation-numbers">
        <strong>{hours(allocated)}</strong>
        <span className="allocation-capacity">
          / {hours(capacity)} <span>h</span>
        </span>
      </div>
      <div className="meter" aria-hidden="true">
        <span style={{ width: `${percentage}%` }} />
      </div>
      {over && <span className="allocation-caption">+{hours(allocated - capacity)} h over</span>}
    </div>
  )
}
