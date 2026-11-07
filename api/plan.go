package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

type planChange struct {
	ID                  int64
	WeeklyHours         float64
	ExpectedWeeklyHours float64
}

func decodeCapacityPlan(body io.Reader) ([]planChange, error) {
	var input struct {
		Changes []struct {
			ID                  int64           `json:"id"`
			WeeklyHours         json.RawMessage `json:"weeklyHours"`
			ExpectedWeeklyHours json.RawMessage `json:"expectedWeeklyHours"`
		} `json:"changes"`
	}
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return nil, err
	}

	var trailing any
	if err := decoder.Decode(&trailing); err == nil {
		return nil, fmt.Errorf("send one JSON object")
	} else if err != io.EOF {
		return nil, err
	}
	if len(input.Changes) < 1 || len(input.Changes) > 100 {
		return nil, fmt.Errorf("a plan must contain between 1 and 100 people")
	}

	// Duplicate IDs would make both expected-value checks and lock intent unclear.
	seen := make(map[int64]bool, len(input.Changes))
	changes := make([]planChange, 0, len(input.Changes))
	for _, raw := range input.Changes {
		if raw.ID < 1 || raw.ID > math.MaxInt32 || seen[raw.ID] {
			return nil, fmt.Errorf("each person must have a distinct positive ID")
		}
		seen[raw.ID] = true
		hours, err := decodeHours(raw.WeeklyHours, "weeklyHours")
		if err != nil {
			return nil, err
		}
		expected, err := decodeHours(raw.ExpectedWeeklyHours, "expectedWeeklyHours")
		if err != nil {
			return nil, err
		}
		changes = append(changes, planChange{raw.ID, hours, expected})
	}
	sort.Slice(changes, func(i, j int) bool { return changes[i].ID < changes[j].ID })
	return changes, nil
}

var errPlanConflict = errors.New("some capacities changed since this plan was prepared")
var errPlanPersonMissing = errors.New("one or more people no longer exist")

// The caller owns the transaction and must roll it back on any error. Locking
// every affected row in ID order keeps competing plans atomic and avoids
// opposite-order lock acquisition. No updates happen until all checks pass.
func applyCapacityPlan(ctx context.Context, tx pgx.Tx, changes []planChange) ([]person, error) {
	ordered := append([]planChange(nil), changes...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ID < ordered[j].ID })
	ids := make([]int32, len(ordered))
	for i, change := range ordered {
		ids[i] = int32(change.ID)
	}

	// Acquire the complete lock set before evaluating any proposed mutation.
	rows, err := tx.Query(ctx, `
        SELECT id, name, weekly_hours::double precision
        FROM people WHERE id = ANY($1::int[])
        ORDER BY id FOR UPDATE`, ids)
	if err != nil {
		return nil, err
	}
	current := make([]person, 0, len(ordered))
	for rows.Next() {
		var entry person
		if err := rows.Scan(&entry.ID, &entry.Name, &entry.WeeklyHours); err != nil {
			rows.Close()
			return nil, err
		}
		current = append(current, entry)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(current) != len(ordered) {
		return current, errPlanPersonMissing
	}

	// Validate every baseline first: one stale person rejects the whole plan.
	for i, entry := range current {
		change := ordered[i]
		if entry.WeeklyHours != change.ExpectedWeeklyHours && entry.WeeklyHours != change.WeeklyHours {
			return current, errPlanConflict
		}
	}

	// Writes begin only after validation, and remain provisional until commit.
	for i, entry := range current {
		if entry.WeeklyHours == ordered[i].WeeklyHours {
			continue // An already-applied plan can safely confirm a lost response.
		}
		if err := tx.QueryRow(ctx, `
            UPDATE people SET weekly_hours = $1 WHERE id = $2
            RETURNING id, name, weekly_hours::double precision`, ordered[i].WeeklyHours, entry.ID).
			Scan(&current[i].ID, &current[i].Name, &current[i].WeeklyHours); err != nil {
			return nil, err
		}
	}
	return current, nil
}

func (s *server) handleCapacityPlan(w http.ResponseWriter, r *http.Request) {
	changes, err := decodeCapacityPlan(http.MaxBytesReader(w, r.Body, 32*1024))
	if err != nil {
		status := http.StatusBadRequest
		var oversized *http.MaxBytesError
		if errors.As(err, &oversized) {
			status = http.StatusRequestEntityTooLarge
		}
		writeJSON(w, status, map[string]string{"error": "Use 1–100 distinct people with valid current and proposed weekly hours."})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), databaseTimeout)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		log.Printf("begin capacity plan: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Could not apply the plan. Please try again."})
		return
	}

	// Cleanup gets its own short context even if the request was disconnected.
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), time.Second)
		defer stop()
		_ = tx.Rollback(cleanup)
	}()

	people, err := applyCapacityPlan(ctx, tx, changes)
	if errors.Is(err, errPlanPersonMissing) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "One or more people no longer exist.", "people": people})
		return
	}
	if errors.Is(err, errPlanConflict) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "Some capacities changed since this plan was prepared.", "people": people})
		return
	}

	// A commit/transport error may leave the client unsure of the outcome;
	// accepting already-desired values makes its unchanged retry safe.
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		log.Printf("apply capacity plan: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Could not confirm the plan. Retry to confirm current values."})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"people": people})
}
