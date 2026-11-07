import { useRef, useState, type FormEvent } from 'react'
import {
  capacityInput,
  hours,
  CapacityConflictError,
  type Person,
  type CanonicalPerson,
} from './capacity'

export function CapacityEditor({
  person,
  busy,
  save,
  onEditing,
  onReconcile,
  saveLabel = 'Save',
  successLabel = 'Saved',
}: {
  person: Person
  busy: boolean
  save: (id: number, hours: number, expectedHours: number) => Promise<void>
  onEditing: (id: number | null) => void
  onReconcile: (id: number) => void
  saveLabel?: string
  successLabel?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [savedHours, setSavedHours] = useState<number | null>(null)
  const [conflict, setConflict] = useState<CanonicalPerson | null>(null)

  // Keep the value seen when editing began, even if canonical props change later.
  const expectedHours = useRef(person.weeklyHours)
  const hoursInput = useRef<HTMLInputElement>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const unsuccessfulSave = useRef(false)

  function close() {
    setEditing(false)
    onEditing(null)

    // Cancel after a failed response must reconcile a possibly committed write.
    if (unsuccessfulSave.current) {
      unsuccessfulSave.current = false
      onReconcile(person.id)
      return
    }
    requestAnimationFrame(() => editButton.current?.focus())
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = capacityInput(draft)
    if (value === null) {
      setError('Enter 0–168 hours, with up to 2 decimal places.')
      return
    }

    setError('')
    try {
      await save(person.id, value, expectedHours.current)
      unsuccessfulSave.current = false
      close()
      setSavedHours(value)
    } catch (failure) {
      // A transport failure can happen after the server commits the update.
      unsuccessfulSave.current = true
      if (failure instanceof CapacityConflictError) {
        setConflict(failure.currentPerson)
        expectedHours.current = failure.currentPerson.weeklyHours
      } else setError(failure instanceof Error ? failure.message : 'Save failed. Please try again.')
      requestAnimationFrame(() => hoursInput.current?.focus())
    }
  }

  if (!editing)
    return (
      <div className="capacity-control">
        <button
          ref={editButton}
          data-person-id={person.id}
          className="capacity-button"
          disabled={busy}
          aria-label={`Edit weekly capacity for ${person.name}`}
          onClick={() => {
            setDraft(String(person.weeklyHours))
            setEditing(true)
            onEditing(person.id)
            setSavedHours(null)
            setError('')
            setConflict(null)
            expectedHours.current = person.weeklyHours
            unsuccessfulSave.current = false
          }}
        >
          <span>
            {hours(person.weeklyHours)} <small>h / week</small>
          </span>
          <span className="edit-hint">Edit</span>
        </button>
        {successLabel && savedHours === person.weeklyHours && (
          <span className="saved-note" role="status">
            {successLabel}
          </span>
        )}
      </div>
    )

  return (
    <form className="capacity-editor" onSubmit={submit} aria-label={`Capacity for ${person.name}`}>
      <label className="sr-only" htmlFor={`hours-${person.id}`}>
        Weekly hours for {person.name}
      </label>
      <input
        ref={hoursInput}
        id={`hours-${person.id}`}
        type="number"
        inputMode="decimal"
        min="0"
        max="168"
        step="0.01"
        autoFocus
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          setError('')
        }}
        disabled={busy}
        aria-invalid={!!error}
        aria-describedby={
          error ? `error-${person.id}` : conflict ? `conflict-${person.id}` : undefined
        }
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) close()
        }}
      />
      <div className="editor-actions">
        <button className="save-button" disabled={busy} type="submit">
          {busy ? 'Saving…' : conflict ? 'Save my draft' : saveLabel}
        </button>
        <button className="text-button" type="button" disabled={busy} onClick={close}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="field-error" id={`error-${person.id}`} role="alert">
          {error}
        </p>
      )}
      {conflict && (
        <div className="conflict-note" id={`conflict-${person.id}`} role="alert">
          <strong>Capacity changed elsewhere</strong>
          <p>Current: {hours(conflict.weeklyHours)} h / week.</p>
          <p>Your draft is kept. Save it explicitly or cancel.</p>
        </div>
      )}
      <span className="editor-help">Applies to every week</span>
    </form>
  )
}
