package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const dateLayout = "2006-01-02"
const databaseTimeout = 5 * time.Second

type capacityWeek struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

type person struct {
	ID          int     `json:"id"`
	Name        string  `json:"name"`
	WeeklyHours float64 `json:"weeklyHours"`
}

type capacityPerson struct {
	person
	AllocatedHours []float64 `json:"allocatedHours"`
}

// Summary describes the entire filtered roster; it must not vary with the page.
type capacitySummary struct {
	People             int     `json:"people"`
	OverCapacityPeople int     `json:"overCapacityPeople"`
	AllocatedHours     float64 `json:"allocatedHours"`
	AvailableHours     float64 `json:"availableHours"`
}

type capacityResponse struct {
	From    string           `json:"from"`
	To      string           `json:"to"`
	Weeks   []capacityWeek   `json:"weeks"`
	People  []capacityPerson `json:"people"`
	Total   int              `json:"total"`
	Offset  int              `json:"offset"`
	Limit   int              `json:"limit"`
	Summary capacitySummary  `json:"summary"`
}

type capacityRange struct {
	from, to time.Time
	offset   int
	limit    int
	search   string
	status   string
	sort     string
}

func parseCapacityRange(query url.Values) (capacityRange, error) {
	var result capacityRange
	from, err := time.Parse(dateLayout, query.Get("from"))
	if err != nil || from.Year() < 1 {
		return result, fmt.Errorf("from must be a valid YYYY-MM-DD date")
	}
	to, err := time.Parse(dateLayout, query.Get("to"))
	if err != nil || to.Year() < 1 {
		return result, fmt.Errorf("to must be a valid YYYY-MM-DD date")
	}
	if to.Before(from) {
		return result, fmt.Errorf("to must be on or after from")
	}
	// Dates represent calendar days, not local timestamps. Always include the
	// complete Monday–Sunday weeks touching the selected range.
	result.from = from.AddDate(0, 0, -(int(from.Weekday())+6)%7)
	lastMonday := to.AddDate(0, 0, -(int(to.Weekday())+6)%7)
	result.to = lastMonday.AddDate(0, 0, 6)
	if result.to.Year() > 9999 || lastMonday.Sub(result.from)/(7*24*time.Hour)+1 > 106 {
		return capacityRange{}, fmt.Errorf("choose a range of at most 106 weeks")
	}

	// Bound the rendered matrix independently of the roster-wide scoring query.
	result.limit = 50
	if raw := query.Get("limit"); raw != "" {
		result.limit, err = strconv.Atoi(raw)
		if err != nil || result.limit < 1 || result.limit > 100 {
			return capacityRange{}, fmt.Errorf("limit must be between 1 and 100")
		}
	}
	if raw := query.Get("offset"); raw != "" {
		result.offset, err = strconv.Atoi(raw)
		if err != nil || result.offset < 0 {
			return capacityRange{}, fmt.Errorf("offset must be a non-negative integer")
		}
	}

	result.search = strings.TrimSpace(query.Get("search"))
	if !utf8.ValidString(result.search) || utf8.RuneCountInString(result.search) > 100 {
		return capacityRange{}, fmt.Errorf("search must contain at most 100 valid characters")
	}

	result.status = query.Get("status")
	if result.status == "" {
		result.status = "all"
	}
	if result.status != "all" && result.status != "over" {
		return capacityRange{}, fmt.Errorf("status must be all or over")
	}

	result.sort = query.Get("sort")
	if result.sort == "" {
		result.sort = "name"
	}
	if result.sort != "name" && result.sort != "overload" {
		return capacityRange{}, fmt.Errorf("sort must be name or overload")
	}
	return result, nil
}

// A search is a literal name fragment, never a LIKE wildcard expression.
func searchPattern(search string) string {
	return "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(search) + "%"
}

// Both pool and transaction satisfy this small boundary, allowing the real SQL
// to be checked against isolated transactional fixtures.
type capacityDB interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

// Score the entire searched roster before status filtering and pagination. Week
// expansion is proportional to each assignment's overlap, not assignments × all
// requested weeks. Within a Monday-based week, weekday indices are simply 0–4.
const capacityQuery = `
WITH matching AS MATERIALIZED (
    SELECT id, name, weekly_hours
    FROM people
    WHERE name ILIKE $5 ESCAPE '\'
), weeks AS (
    SELECT $1::date + index * 7 AS week_start
    FROM generate_series(0, ($2::date - $1::date) / 7) AS series(index)
), scoped_assignments AS MATERIALIZED (
    -- Equal date intervals share their weekday weight; SUM preserves every
    -- assignment's contribution while avoiding repeated calendar expansion.
    SELECT a.person_id, a.start_date, a.end_date, SUM(a.hours_per_day) AS hours_per_day
    FROM assignments a
    JOIN matching p ON p.id = a.person_id
    WHERE a.start_date <= $2::date AND a.end_date >= $1::date
    GROUP BY a.person_id, a.start_date, a.end_date
), allocated AS (
    SELECT a.person_id, w.week_start::date AS week_start,
           SUM(a.hours_per_day * GREATEST(0,
               LEAST(4, a.end_date - w.week_start::date)
               - GREATEST(0, a.start_date - w.week_start::date) + 1
           )) AS hours
    FROM scoped_assignments a
    CROSS JOIN LATERAL generate_series(
        date_trunc('week', GREATEST(a.start_date, $1::date)::timestamp),
        date_trunc('week', LEAST(a.end_date, $2::date)::timestamp),
        interval '1 week'
    ) AS w(week_start)
    GROUP BY a.person_id, w.week_start
), scored AS MATERIALIZED (
    SELECT p.id, p.name, p.weekly_hours,
           array_agg(COALESCE(a.hours, 0) ORDER BY w.week_start) AS allocated_hours,
           MAX(GREATEST(COALESCE(a.hours, 0) - p.weekly_hours, 0)) AS peak_over,
           SUM(COALESCE(a.hours, 0)) AS allocated_total,
           SUM(GREATEST(p.weekly_hours - COALESCE(a.hours, 0), 0)) AS available_total
    FROM matching p
    CROSS JOIN weeks w
    LEFT JOIN allocated a ON a.person_id = p.id AND a.week_start = w.week_start
    GROUP BY p.id, p.name, p.weekly_hours
), eligible AS MATERIALIZED (
    SELECT * FROM scored WHERE $6 <> 'over' OR peak_over > 0
), page AS (
    SELECT * FROM eligible
    ORDER BY CASE WHEN $7 = 'overload' THEN peak_over END DESC, name, id
    LIMIT $3 OFFSET $4
)
SELECT count(*)::int,
       count(*) FILTER (WHERE peak_over > 0)::int,
       COALESCE(sum(allocated_total), 0)::double precision,
       COALESCE(sum(available_total), 0)::double precision,
       (SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', id, 'name', name, 'weeklyHours', weekly_hours,
           'allocatedHours', allocated_hours
       ) ORDER BY CASE WHEN $7 = 'overload' THEN peak_over END DESC, name, id), '[]'::jsonb)
        FROM page)
FROM eligible`

func loadCapacity(ctx context.Context, db capacityDB, selected capacityRange) (capacityResponse, error) {
	result := capacityResponse{
		From: selected.from.Format(dateLayout), To: selected.to.Format(dateLayout),
		Weeks: []capacityWeek{}, People: []capacityPerson{},
		Offset: selected.offset, Limit: selected.limit,
	}

	// Keep week labels and every person's allocation array on the same index axis.
	for start := selected.from; !start.After(selected.to); start = start.AddDate(0, 0, 7) {
		result.Weeks = append(result.Weeks, capacityWeek{
			Start: start.Format(dateLayout), End: start.AddDate(0, 0, 6).Format(dateLayout),
		})
	}

	var encodedPeople []byte
	err := db.QueryRow(ctx, capacityQuery, result.From, result.To,
		selected.limit, selected.offset, searchPattern(selected.search), selected.status, selected.sort).
		Scan(&result.Total, &result.Summary.OverCapacityPeople,
			&result.Summary.AllocatedHours, &result.Summary.AvailableHours, &encodedPeople)
	if err != nil {
		return result, err
	}

	result.Summary.People = result.Total
	if err := json.Unmarshal(encodedPeople, &result.People); err != nil {
		return result, err
	}
	return result, nil
}

func (s *server) handleCapacity(w http.ResponseWriter, r *http.Request) {
	selected, err := parseCapacityRange(r.URL.Query())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	// Cancel database work when either the request or its bounded budget expires.
	ctx, cancel := context.WithTimeout(r.Context(), databaseTimeout)
	defer cancel()
	result, err := loadCapacity(ctx, s.db, selected)
	if err != nil {
		log.Printf("load capacity: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Could not load capacity. Please try again."})
		return
	}
	writeJSON(w, http.StatusOK, result)
}
