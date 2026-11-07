package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"
)

type capacityUpdate struct {
	WeeklyHours         float64
	ExpectedWeeklyHours float64
}

func decodeCapacityUpdate(body io.Reader) (capacityUpdate, error) {
	var raw struct {
		WeeklyHours         json.RawMessage `json:"weeklyHours"`
		ExpectedWeeklyHours json.RawMessage `json:"expectedWeeklyHours"`
	}
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&raw); err != nil {
		return capacityUpdate{}, err
	}

	// Reject trailing JSON so one request cannot ambiguously describe two edits.
	var extra any
	if err := decoder.Decode(&extra); err == nil {
		return capacityUpdate{}, fmt.Errorf("expected one JSON object")
	} else if err != io.EOF {
		return capacityUpdate{}, err
	}
	hours, err := decodeHours(raw.WeeklyHours, "weeklyHours")
	if err != nil {
		return capacityUpdate{}, err
	}
	expected, err := decodeHours(raw.ExpectedWeeklyHours, "expectedWeeklyHours")
	if err != nil {
		return capacityUpdate{}, err
	}
	return capacityUpdate{WeeklyHours: hours, ExpectedWeeklyHours: expected}, nil
}

func decodeHours(raw json.RawMessage, field string) (float64, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return 0, fmt.Errorf("%s is required", field)
	}
	var hours float64
	if err := json.Unmarshal(raw, &hours); err != nil {
		return 0, fmt.Errorf("%s must be a number", field)
	}
	if math.IsNaN(hours) || math.IsInf(hours, 0) || hours < 0 || hours > 168 || hours != math.Round(hours*100)/100 {
		return 0, fmt.Errorf("%s must be between 0 and 168 with at most two decimal places", field)
	}
	return hours, nil
}

var errCapacityConflict = errors.New("weekly capacity changed since this edit was opened")

// The compare-and-set predicate makes competing updates atomic. If an earlier
// response was lost, retrying the already-applied value confirms its success.
func updatePersonCapacity(ctx context.Context, db capacityDB, id int64, update capacityUpdate) (person, error) {
	var current person
	err := db.QueryRow(ctx, `
        UPDATE people SET weekly_hours = $1
        WHERE id = $2 AND weekly_hours = $3
        RETURNING id, name, weekly_hours::double precision`, update.WeeklyHours, id, update.ExpectedWeeklyHours).
		Scan(&current.ID, &current.Name, &current.WeeklyHours)
	if !errors.Is(err, pgx.ErrNoRows) {
		return current, err
	}

	// A failed predicate can mean a missing person, a conflict, or a retry after
	// the first write committed but its response never reached the browser.
	err = db.QueryRow(ctx, `SELECT id, name, weekly_hours::double precision FROM people WHERE id = $1`, id).
		Scan(&current.ID, &current.Name, &current.WeeklyHours)
	if err != nil {
		return current, err
	}

	if current.WeeklyHours == update.WeeklyHours {
		return current, nil
	}
	return current, errCapacityConflict
}

func (s *server) handleUpdatePerson(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 32)
	if err != nil || id < 1 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid person ID."})
		return
	}

	update, err := decodeCapacityUpdate(http.MaxBytesReader(w, r.Body, 4096))
	if err != nil {
		status := http.StatusBadRequest
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			status = http.StatusRequestEntityTooLarge
		}
		writeJSON(w, status, map[string]string{"error": "Enter weeklyHours and expectedWeeklyHours from 0 to 168, with at most two decimal places."})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), databaseTimeout)
	defer cancel()
	updated, err := updatePersonCapacity(ctx, s.db, id, update)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Person not found."})
		return
	}
	if errors.Is(err, errCapacityConflict) {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "Weekly capacity changed since you opened this edit.", "person": updated,
		})
		return
	}
	if err != nil {
		log.Printf("save weekly hours: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Could not save weekly hours. Please try again."})
		return
	}
	writeJSON(w, http.StatusOK, updated)
}
