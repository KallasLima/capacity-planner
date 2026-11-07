package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestAllocationWeekValidationAndYearBoundary(t *testing.T) {
	week, err := parseAllocationWeek("2026-01-01")
	if err != nil || week.Start != "2025-12-29" || week.End != "2026-01-04" {
		t.Fatalf("incorrect week: %+v %v", week, err)
	}
	for _, value := range []string{"", "2026-02-30", "0000-01-01", "9999-12-31"} {
		if _, err := parseAllocationWeek(value); err == nil {
			t.Fatalf("accepted invalid week %q", value)
		}
	}
}

func TestAllocationBreakdownRejectsInvalidRequestsBeforeDatabaseAccess(t *testing.T) {
	s := &server{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/people/{id}/allocations", s.handleAllocationBreakdown)
	for _, path := range []string{
		"/api/people/-1/allocations?week=2026-01-05",
		"/api/people/nope/allocations?week=2026-01-05",
		"/api/people/1/allocations",
		"/api/people/1/allocations?week=2026-02-30",
	} {
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s: status %d", path, response.Code)
		}
	}
}

func TestAllocationBreakdownSumsProjectsAndPreservesAssignmentRows(t *testing.T) {
	ctx, tx := testTransaction(t)
	_, err := tx.Exec(ctx, `
        CREATE TEMP TABLE people (id int PRIMARY KEY,name text,weekly_hours numeric) ON COMMIT DROP;
        CREATE TEMP TABLE projects (id int PRIMARY KEY,name text) ON COMMIT DROP;
        CREATE TEMP TABLE assignments (id int PRIMARY KEY,person_id int,project_id int,start_date date,end_date date,hours_per_day numeric) ON COMMIT DROP;
        INSERT INTO people VALUES (1,'Ana',40),(2,'Bo',0);
        INSERT INTO projects VALUES (1,'Core'),(2,'Alpha'),(3,'Weekend'),(4,'Zeta');
        INSERT INTO assignments VALUES
            (1,1,1,'2026-01-05','2026-01-09',2),
            (2,1,1,'2026-01-05','2026-01-09',2),
            (3,1,2,'2026-01-09','2026-01-12',3),
            (4,1,3,'2026-01-10','2026-01-11',100),
            (5,1,1,'2025-12-01','2025-12-05',100),
            (6,2,1,'2026-01-05','2026-01-09',200),
            (7,1,4,'2026-01-05','2026-01-05',3);
    `)
	if err != nil {
		t.Fatal(err)
	}
	week, err := parseAllocationWeek("2026-01-07")
	if err != nil {
		t.Fatal(err)
	}
	result, err := loadAllocationBreakdown(ctx, tx, 1, week)
	if err != nil {
		t.Fatal(err)
	}
	if result.Person.ID != 1 || result.Person.WeeklyHours != 40 || result.Week.Start != "2026-01-05" || result.Week.End != "2026-01-11" || result.AllocatedHours != 26 || len(result.Projects) != 3 {
		t.Fatalf("incorrect breakdown: %+v", result)
	}
	if result.Projects[0].Name != "Core" || result.Projects[0].Hours != 20 || result.Projects[0].AssignmentCount != 2 {
		t.Fatalf("duplicate assignments lost: %+v", result.Projects)
	}
	if result.Projects[1].Name != "Alpha" || result.Projects[1].Hours != 3 || result.Projects[1].AssignmentCount != 1 || result.Projects[2].Name != "Zeta" {
		t.Fatalf("overlap or deterministic order incorrect: %+v", result.Projects)
	}
	emptyWeek, _ := parseAllocationWeek("2026-02-01")
	empty, err := loadAllocationBreakdown(ctx, tx, 1, emptyWeek)
	if err != nil || empty.AllocatedHours != 0 || empty.Projects == nil || len(empty.Projects) != 0 {
		t.Fatalf("empty allocation: %+v %v", empty, err)
	}
	_, err = loadAllocationBreakdown(ctx, tx, 999, week)
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("missing person: %v", err)
	}
}
