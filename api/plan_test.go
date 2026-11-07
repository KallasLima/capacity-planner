package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPlanDecodingBoundsRequiredFieldsAndStableOrder(t *testing.T) {
	valid := `{"changes":[{"id":2,"weeklyHours":0,"expectedWeeklyHours":32.29},{"id":1,"weeklyHours":168,"expectedWeeklyHours":0}]}`
	changes, err := decodeCapacityPlan(strings.NewReader(valid))
	if err != nil || len(changes) != 2 || changes[0].ID != 1 || changes[1].WeeklyHours != 0 || changes[1].ExpectedWeeklyHours != 32.29 {
		t.Fatalf("incorrect valid plan: %+v, %v", changes, err)
	}
	for _, body := range []string{
		`{}`, `null`, `[]`, `{"changes":[]}`, `{"changes":null}`,
		`{"changes":[{"id":1,"weeklyHours":20}]}`,
		`{"changes":[{"id":1,"weeklyHours":null,"expectedWeeklyHours":40}]}`,
		`{"changes":[{"id":1,"weeklyHours":20,"expectedWeeklyHours":null}]}`,
		`{"changes":[{"id":0,"weeklyHours":20,"expectedWeeklyHours":40}]}`,
		`{"changes":[{"id":-1,"weeklyHours":20,"expectedWeeklyHours":40}]}`,
		`{"changes":[{"id":2147483648,"weeklyHours":20,"expectedWeeklyHours":40}]}`,
		`{"changes":[{"id":1.5,"weeklyHours":20,"expectedWeeklyHours":40}]}`,
		`{"changes":[{"id":1,"weeklyHours":169,"expectedWeeklyHours":40}]}`,
		`{"changes":[{"id":1,"weeklyHours":-1,"expectedWeeklyHours":40}]}`,
		`{"changes":[{"id":1,"weeklyHours":20.001,"expectedWeeklyHours":40}]}`,
		`{"changes":[{"id":1,"weeklyHours":"20","expectedWeeklyHours":40}]}`,
		`{"changes":[{"id":1,"weeklyHours":20,"expectedWeeklyHours":40,"name":"changed"}]}`,
		`{"changes":[{"id":1,"weeklyHours":20,"expectedWeeklyHours":40}],"unexpected":true}`,
		`{"changes":[{"id":1,"weeklyHours":20,"expectedWeeklyHours":40},{"id":1,"weeklyHours":30,"expectedWeeklyHours":40}]}`,
		valid + ` {}`,
	} {
		t.Run(body, func(t *testing.T) {
			if _, err := decodeCapacityPlan(strings.NewReader(body)); err == nil {
				t.Fatal("accepted invalid plan")
			}
		})
	}
	entries := make([]string, 101)
	for i := range entries {
		entries[i] = fmt.Sprintf(`{"id":%d,"weeklyHours":40,"expectedWeeklyHours":40}`, i+1)
	}
	if _, err := decodeCapacityPlan(strings.NewReader(`{"changes":[` + strings.Join(entries[:100], ",") + `]}`)); err != nil {
		t.Fatalf("100-person plan rejected: %v", err)
	}
	if _, err := decodeCapacityPlan(strings.NewReader(`{"changes":[` + strings.Join(entries, ",") + `]}`)); err == nil {
		t.Fatal("accepted more than 100 changes")
	}
}

func TestPlanRejectsMalformedAndOversizedBodiesBeforeDatabaseAccess(t *testing.T) {
	s := &server{}
	for _, test := range []struct {
		body   string
		status int
	}{
		{`{"changes":[]}`, http.StatusBadRequest},
		{`{"changes":[{"id":1,"weeklyHours":40}]}`, http.StatusBadRequest},
		{`{"changes":[],"` + strings.Repeat("x", 40*1024) + `":true}`, http.StatusRequestEntityTooLarge},
		{`{"changes":[{"id":1,"weeklyHours":20,"expectedWeeklyHours":40}]}` + strings.Repeat(" ", 40*1024), http.StatusRequestEntityTooLarge},
	} {
		response := httptest.NewRecorder()
		s.handleCapacityPlan(response, httptest.NewRequest(http.MethodPatch, "/api/people/capacities", strings.NewReader(test.body)))
		if response.Code != test.status {
			t.Fatalf("got %d, want %d: %s", response.Code, test.status, response.Body.String())
		}
		var body map[string]string
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body["error"] == "" {
			t.Fatalf("missing useful JSON error: %s, %v", response.Body.String(), err)
		}
	}
}

func TestPlanAtomicConflictMissingRetryAndSuccessfulBatch(t *testing.T) {
	ctx, tx := testTransaction(t)
	if _, err := tx.Exec(ctx, `
        CREATE TEMP TABLE people (id int PRIMARY KEY, name text, weekly_hours numeric) ON COMMIT DROP;
        INSERT INTO people VALUES (1, 'Ana', 40), (2, 'Bo', 20), (3, 'Cem', 0);
    `); err != nil {
		t.Fatal(err)
	}
	assertHours := func(want1, want2, want3 float64) {
		t.Helper()
		var a, b, c float64
		if err := tx.QueryRow(ctx, `SELECT
            (SELECT weekly_hours::double precision FROM people WHERE id=1),
            (SELECT weekly_hours::double precision FROM people WHERE id=2),
            (SELECT weekly_hours::double precision FROM people WHERE id=3)`).Scan(&a, &b, &c); err != nil || a != want1 || b != want2 || c != want3 {
			t.Fatalf("capacities = %v/%v/%v, expected %v/%v/%v: %v", a, b, c, want1, want2, want3, err)
		}
	}
	// The first person matches, but the second has changed elsewhere. Nothing is written.
	current, err := applyCapacityPlan(ctx, tx, []planChange{{1, 50, 40}, {2, 30, 10}})
	if !errors.Is(err, errPlanConflict) || len(current) != 2 || current[0].WeeklyHours != 40 || current[1].WeeklyHours != 20 {
		t.Fatalf("conflict must return all current requested values: %+v, %v", current, err)
	}
	assertHours(40, 20, 0)
	_, err = applyCapacityPlan(ctx, tx, []planChange{{1, 50, 40}, {99, 30, 20}})
	if !errors.Is(err, errPlanPersonMissing) {
		t.Fatalf("missing person: %v", err)
	}
	assertHours(40, 20, 0)
	// Input order differs from lock/response order; zero and decimals are valid.
	plan := []planChange{{3, 16.25, 0}, {1, 50, 40}, {2, 0, 20}}
	saved, err := applyCapacityPlan(ctx, tx, plan)
	if err != nil || len(saved) != 3 || saved[0].ID != 1 || saved[1].ID != 2 || saved[2].ID != 3 {
		t.Fatalf("successful plan: %+v, %v", saved, err)
	}
	assertHours(50, 0, 16.25)
	// Retrying the exact original request confirms a previously committed state.
	if _, err := applyCapacityPlan(ctx, tx, plan); err != nil {
		t.Fatalf("same-value retry failed: %v", err)
	}
	assertHours(50, 0, 16.25)
	_, err = applyCapacityPlan(ctx, tx, []planChange{{1, 32, 40}, {3, 24, 16.25}})
	if !errors.Is(err, errPlanConflict) {
		t.Fatalf("stale plan must conflict: %v", err)
	}
	assertHours(50, 0, 16.25)
}
