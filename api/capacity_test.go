package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestCapacityRangeIncludesCompleteWeeksAcrossYearBoundary(t *testing.T) {
	selected, err := parseCapacityRange(url.Values{"from": {"2025-12-31"}, "to": {"2026-01-04"}})
	if err != nil {
		t.Fatal(err)
	}
	if selected.from.Format(dateLayout) != "2025-12-29" || selected.to.Format(dateLayout) != "2026-01-04" {
		t.Fatalf("incorrect normalized range: %+v", selected)
	}
	if selected.limit != 50 || selected.offset != 0 {
		t.Fatalf("incorrect default pagination: %+v", selected)
	}
}

func TestCapacityRejectsInvalidRangesAndPagination(t *testing.T) {
	for _, query := range []string{
		"from=2026-02-30&to=2026-03-01",
		"from=0000-01-01&to=2026-01-01",
		"from=2026-01-12&to=2026-01-11",
		"from=2024-01-01&to=2026-12-31",
		"from=2026-01-01&to=2026-01-01&limit=0",
		"from=2026-01-01&to=2026-01-01&limit=101",
		"from=2026-01-01&to=2026-01-01&offset=-1",
		"from=2026-01-01&to=2026-01-01&offset=oops",
		"from=9999-12-31&to=9999-12-31",
	} {
		t.Run(query, func(t *testing.T) {
			values, err := url.ParseQuery(query)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := parseCapacityRange(values); err == nil {
				t.Fatal("accepted invalid request")
			}
		})
	}
}

// Run with DATABASE_URL (as supplied by the API container) or TEST_DATABASE_URL.
// Temporary tables shadow the seed only inside this rolled-back transaction.
func TestCapacityQueryWeekdaysDuplicatesAndPagination(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run the PostgreSQL query test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	_, err = tx.Exec(ctx, `
        CREATE TEMP TABLE people (id int PRIMARY KEY, name text, weekly_hours numeric) ON COMMIT DROP;
        CREATE TEMP TABLE assignments (
            id int PRIMARY KEY, person_id int, start_date date, end_date date, hours_per_day numeric
        ) ON COMMIT DROP;
        INSERT INTO people VALUES (1, 'Ana', 0), (2, 'Bo', 40), (3, 'Bo', 20);
        INSERT INTO assignments VALUES
            (1, 1, '2026-01-09', '2026-01-12', 2),
            (2, 2, '2026-01-05', '2026-01-09', 2),
            (3, 2, '2026-01-05', '2026-01-09', 2),
            (4, 2, '2026-01-10', '2026-01-11', 100),
            (5, 2, '2025-12-01', '2025-12-05', 100);
    `)
	if err != nil {
		t.Fatal(err)
	}
	selected, err := parseCapacityRange(url.Values{"from": {"2026-01-07"}, "to": {"2026-01-13"}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := loadCapacity(ctx, tx, selected)
	if err != nil {
		t.Fatal(err)
	}
	if result.From != "2026-01-05" || result.To != "2026-01-18" || len(result.Weeks) != 2 || result.Total != 3 {
		t.Fatalf("incorrect range or total: %+v", result)
	}
	if len(result.People) != 3 || result.People[0].WeeklyHours != 0 ||
		!reflect.DeepEqual(result.People[0].AllocatedHours, []float64{2, 2}) ||
		!reflect.DeepEqual(result.People[1].AllocatedHours, []float64{20, 0}) ||
		!reflect.DeepEqual(result.People[2].AllocatedHours, []float64{0, 0}) {
		t.Fatalf("incorrect weekday allocation, duplicate preservation, or empty person: %+v", result.People)
	}
	selected.offset, selected.limit = 1, 1
	page, err := loadCapacity(ctx, tx, selected)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 3 || len(page.People) != 1 || page.People[0].ID != 2 {
		t.Fatalf("incorrect stable pagination: %+v", page)
	}
	selected.offset = 99
	empty, err := loadCapacity(ctx, tx, selected)
	if err != nil || empty.Total != 3 || empty.People == nil || len(empty.People) != 0 {
		t.Fatalf("incorrect empty page: %+v, %v", empty, err)
	}
}

func TestUpdateRejectsInvalidInputBeforeDatabaseAccess(t *testing.T) {
	s := &server{}
	mux := http.NewServeMux()
	mux.HandleFunc("PATCH /api/people/{id}", s.handleUpdatePerson)
	for _, test := range []struct {
		name, id, body string
		status         int
	}{
		{"missing value", "1", `{}`, http.StatusBadRequest},
		{"null value", "1", `{"weeklyHours":null}`, http.StatusBadRequest},
		{"invalid person", "-1", `{"weeklyHours":40}`, http.StatusBadRequest},
		{"non-integer person", "nope", `{"weeklyHours":40}`, http.StatusBadRequest},
		{"oversized body", "1", `{"weeklyHours":40,"` + strings.Repeat("x", 5000) + `":0}`, http.StatusRequestEntityTooLarge},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPatch, "/api/people/"+test.id, strings.NewReader(test.body))
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.status, response.Body.String())
			}
		})
	}
}

func TestCapacitySearchValidation(t *testing.T) {
	values := url.Values{"from": {"2026-01-01"}, "to": {"2026-01-01"}, "search": {"  Élodie\u2003"}}
	selected, err := parseCapacityRange(values)
	if err != nil || selected.search != "Élodie" {
		t.Fatalf("Unicode trim: %+v %v", selected, err)
	}
	values.Set("search", strings.Repeat("é", 100))
	if _, err := parseCapacityRange(values); err != nil {
		t.Fatal("100 runes should be accepted", err)
	}
	values.Set("search", strings.Repeat("é", 101))
	if _, err := parseCapacityRange(values); err == nil {
		t.Fatal("accepted oversized search")
	}
	values.Set("search", string([]byte{0xff}))
	if _, err := parseCapacityRange(values); err == nil {
		t.Fatal("accepted invalid UTF-8 search")
	}
}

func TestCapacitySearchFiltersBeforePaginationAndEscapesWildcards(t *testing.T) {
	ctx, tx := testTransaction(t)
	_, err := tx.Exec(ctx, `
        CREATE TEMP TABLE people (id int PRIMARY KEY, name text, weekly_hours numeric) ON COMMIT DROP;
        CREATE TEMP TABLE assignments (id int PRIMARY KEY, person_id int, start_date date, end_date date, hours_per_day numeric) ON COMMIT DROP;
        INSERT INTO people VALUES (1,'Ana',40),(2,'Bo',40),(3,'Élodie',32),(4,E'Bo _100%\\path',20);
        INSERT INTO assignments VALUES (1,4,'2026-01-05','2026-01-09',2);
    `)
	if err != nil {
		t.Fatal(err)
	}
	selected, err := parseCapacityRange(url.Values{"from": {"2026-01-05"}, "to": {"2026-01-11"}, "search": {"bO"}, "limit": {"1"}, "offset": {"1"}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := loadCapacity(ctx, tx, selected)
	if err != nil || result.Total != 2 || len(result.People) != 1 || result.People[0].ID != 4 || result.People[0].AllocatedHours[0] != 10 {
		t.Fatalf("filtered stable page: %+v %v", result, err)
	}
	selected.offset = 0
	selected.limit = 50
	selected.search = `_100%\path`
	literal, err := loadCapacity(ctx, tx, selected)
	if err != nil || literal.Total != 1 || len(literal.People) != 1 || literal.People[0].ID != 4 {
		t.Fatalf("literal wildcard/backslash: %+v %v", literal, err)
	}
	selected.search = "ÉLO"
	unicode, err := loadCapacity(ctx, tx, selected)
	if err != nil || unicode.Total != 1 || unicode.People[0].ID != 3 {
		t.Fatalf("Unicode search: %+v %v", unicode, err)
	}
	selected.search = "missing"
	empty, err := loadCapacity(ctx, tx, selected)
	if err != nil || empty.Total != 0 || empty.People == nil || len(empty.People) != 0 {
		t.Fatalf("empty search: %+v %v", empty, err)
	}
}

func TestCapacityPriorityValidation(t *testing.T) {
	base := url.Values{"from": {"2026-01-05"}, "to": {"2026-01-11"}}
	selected, err := parseCapacityRange(base)
	if err != nil || selected.status != "all" || selected.sort != "name" {
		t.Fatalf("defaults: %+v %v", selected, err)
	}
	for _, field := range []string{"status", "sort"} {
		base.Set(field, "unsupported")
		if _, err := parseCapacityRange(base); err == nil {
			t.Fatalf("accepted invalid %s", field)
		}
		base.Del(field)
	}
}

func TestCapacityPriorityAndSummaryCoverEntireEligibleRoster(t *testing.T) {
	ctx, tx := testTransaction(t)
	_, err := tx.Exec(ctx, `
        CREATE TEMP TABLE people (id int PRIMARY KEY, name text, weekly_hours numeric) ON COMMIT DROP;
        CREATE TEMP TABLE assignments (id int PRIMARY KEY, person_id int, start_date date, end_date date, hours_per_day numeric) ON COMMIT DROP;
        INSERT INTO people VALUES (1,'Ana',40),(2,'Bo',20),(3,'Cy',0),(4,'Dee',40),(5,'Eve',20),(6,'Zoe',20);
        INSERT INTO assignments VALUES
          (1,1,'2026-01-05','2026-01-09',2),
          (2,2,'2026-01-05','2026-01-09',10),
          (3,2,'2026-01-12','2026-01-12',1),
          (4,3,'2026-01-10','2026-01-11',100),
          (5,4,'2026-01-05','2026-01-09',9),
          (6,5,'2026-01-12','2026-01-16',12),
          (7,6,'2026-01-05','2026-01-09',4),
          (8,6,'2026-01-05','2026-01-09',4);
    `)
	if err != nil {
		t.Fatal(err)
	}
	selected, err := parseCapacityRange(url.Values{"from": {"2026-01-05"}, "to": {"2026-01-18"}, "limit": {"1"}})
	if err != nil {
		t.Fatal(err)
	}
	all, err := loadCapacity(ctx, tx, selected)
	if err != nil || all.Total != 6 || len(all.People) != 1 || all.People[0].ID != 1 ||
		all.Summary.People != 6 || all.Summary.OverCapacityPeople != 4 || all.Summary.AllocatedHours != 206 || all.Summary.AvailableHours != 169 {
		t.Fatalf("global summary beyond page: %+v %v", all, err)
	}
	selected.status, selected.sort, selected.limit, selected.offset = "over", "overload", 2, 1
	over, err := loadCapacity(ctx, tx, selected)
	if err != nil || over.Total != 4 || len(over.People) != 2 || over.People[0].ID != 2 || over.People[1].ID != 6 ||
		over.Summary.People != 4 || over.Summary.OverCapacityPeople != 4 || over.Summary.AllocatedHours != 196 || over.Summary.AvailableHours != 99 {
		t.Fatalf("global status/order before page: %+v %v", over, err)
	}
	selected.search, selected.offset = "o", 0
	searched, err := loadCapacity(ctx, tx, selected)
	if err != nil || searched.Total != 2 || searched.Summary.AllocatedHours != 91 || searched.Summary.AvailableHours != 39 {
		t.Fatalf("searched eligible summary: %+v %v", searched, err)
	}
	selected.offset = 99
	emptyPage, err := loadCapacity(ctx, tx, selected)
	if err != nil || emptyPage.Total != 2 || len(emptyPage.People) != 0 || emptyPage.People == nil || emptyPage.Summary.AllocatedHours != 91 {
		t.Fatalf("empty page retains summary: %+v %v", emptyPage, err)
	}
	selected.search = "missing"
	empty, err := loadCapacity(ctx, tx, selected)
	if err != nil || empty.Total != 0 || empty.People == nil || empty.Summary != (capacitySummary{}) {
		t.Fatalf("empty eligible roster: %+v %v", empty, err)
	}
}
