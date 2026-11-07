package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

type projectAllocation struct {
	ID              int     `json:"id"`
	Name            string  `json:"name"`
	Hours           float64 `json:"hours"`
	AssignmentCount int     `json:"assignmentCount"`
}

type allocationBreakdown struct {
	Person         person              `json:"person"`
	Week           capacityWeek        `json:"week"`
	AllocatedHours float64             `json:"allocatedHours"`
	Projects       []projectAllocation `json:"projects"`
}

// Normalize details to the same full Monday-based weeks used by the grid.
func parseAllocationWeek(raw string) (capacityWeek, error) {
	day, err := time.Parse(dateLayout, raw)
	if err != nil || day.Year() < 1 {
		return capacityWeek{}, fmt.Errorf("week must be a valid YYYY-MM-DD date")
	}
	start := day.AddDate(0, 0, -(int(day.Weekday())+6)%7)
	end := start.AddDate(0, 0, 6)
	if end.Year() > 9999 {
		return capacityWeek{}, fmt.Errorf("week is outside the supported date range")
	}
	return capacityWeek{Start: start.Format(dateLayout), End: end.Format(dateLayout)}, nil
}

// Expand only the selected week's five weekdays. Every source assignment remains
// additive, including records with equal dates and hours but distinct IDs.
const allocationBreakdownQuery = `
WITH scoped AS MATERIALIZED (
    SELECT a.id, a.project_id, a.hours_per_day,
           (SELECT count(*) FROM generate_series(0,4) AS weekdays(day)
            WHERE $2::date + weekdays.day BETWEEN a.start_date AND a.end_date) AS workdays
    FROM assignments a
    WHERE a.person_id=$1 AND a.start_date<=$3::date AND a.end_date>=$2::date
), per_project AS (
    SELECT p.id,p.name,SUM(s.hours_per_day*s.workdays) AS hours,
           count(*) AS assignment_count
    FROM scoped s
    JOIN projects p ON p.id=s.project_id
    WHERE s.workdays>0
    GROUP BY p.id,p.name
)
SELECT id,name,hours::double precision,assignment_count,
       SUM(hours) OVER ()::double precision AS total_hours
FROM per_project
ORDER BY hours DESC,name,id`

func loadAllocationBreakdown(ctx context.Context, db capacityDB, id int64, week capacityWeek) (allocationBreakdown, error) {
	result := allocationBreakdown{Week: week, Projects: []projectAllocation{}}
	err := db.QueryRow(ctx, `SELECT id,name,weekly_hours::double precision FROM people WHERE id=$1`, id).
		Scan(&result.Person.ID, &result.Person.Name, &result.Person.WeeklyHours)
	if err != nil {
		return result, err
	}

	// Looking up the person separately distinguishes a missing person from an
	// existing person whose selected week simply has no project allocations.
	rows, err := db.Query(ctx, allocationBreakdownQuery, id, week.Start, week.End)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var project projectAllocation
		if err := rows.Scan(&project.ID, &project.Name, &project.Hours, &project.AssignmentCount, &result.AllocatedHours); err != nil {
			return result, err
		}
		result.Projects = append(result.Projects, project)
	}
	return result, rows.Err()
}

func (s *server) handleAllocationBreakdown(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 32)
	if err != nil || id < 1 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid person ID."})
		return
	}

	week, err := parseAllocationWeek(r.URL.Query().Get("week"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), databaseTimeout)
	defer cancel()
	result, err := loadAllocationBreakdown(ctx, s.db, id, week)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Person not found."})
		return
	}
	if err != nil {
		log.Printf("load allocation breakdown: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Could not load project allocations. Please try again."})
		return
	}
	writeJSON(w, http.StatusOK, result)
}
