package main

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestCapacityUpdateAcceptsZeroAndDecimalCapacity(t *testing.T) {
	for _, test := range []struct {
		body           string
		want, expected float64
	}{
		{`{"weeklyHours":0,"expectedWeeklyHours":40}`, 0, 40},
		{`{"weeklyHours":32.25,"expectedWeeklyHours":32.29}`, 32.25, 32.29},
		{`{"weeklyHours":168,"expectedWeeklyHours":0}`, 168, 0},
	} {
		got, err := decodeCapacityUpdate(strings.NewReader(test.body))
		if err != nil || got.WeeklyHours != test.want || got.ExpectedWeeklyHours != test.expected {
			t.Fatalf("%s: got %+v, %v", test.body, got, err)
		}
	}
}

func TestCapacityUpdateRejectsAmbiguousOrInvalidUpdates(t *testing.T) {
	for _, body := range []string{
		`{}`, `null`, `[]`, `{"weeklyHours":null,"expectedWeeklyHours":40}`,
		`{"weeklyHours":"40","expectedWeeklyHours":40}`, `{"weeklyHours":40}`,
		`{"weeklyHours":40,"expectedWeeklyHours":null}`, `{"weeklyHours":40,"expectedWeeklyHours":"40"}`,
		`{"weeklyHours":40,"expectedWeeklyHours":-1}`, `{"weeklyHours":40,"expectedWeeklyHours":169}`,
		`{"weeklyHours":40,"expectedWeeklyHours":0.001}`, `{"weeklyHours":-1,"expectedWeeklyHours":40}`,
		`{"weeklyHours":169,"expectedWeeklyHours":40}`, `{"weeklyHours":0.001,"expectedWeeklyHours":40}`,
		`{"weeklyHours":1e-11,"expectedWeeklyHours":40}`, `{"weeklyHours":1e999,"expectedWeeklyHours":40}`,
		`{"weeklyHours":NaN,"expectedWeeklyHours":40}`, `{"weeklyHours":true,"expectedWeeklyHours":40}`,
		`{"weeklyHours":40,"expectedWeeklyHours":40,"name":"changed"}`,
		`{"weeklyHours":40,"expectedWeeklyHours":40} {"weeklyHours":20}`,
	} {
		t.Run(body, func(t *testing.T) {
			if _, err := decodeCapacityUpdate(strings.NewReader(body)); err == nil {
				t.Fatal("accepted invalid or ambiguous update")
			}
		})
	}
}

func testTransaction(t *testing.T) (context.Context, pgx.Tx) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tx.Rollback(context.Background()) })
	return ctx, tx
}

func TestCapacityUpdateCompareAndSetAndIdempotentRetry(t *testing.T) {
	ctx, tx := testTransaction(t)
	_, err := tx.Exec(ctx, `
        CREATE TEMP TABLE people (id int PRIMARY KEY, name text, weekly_hours numeric) ON COMMIT DROP;
        INSERT INTO people VALUES (1, 'Ana', 40), (2, 'Bo', 0), (3, 'Cem', 32.29);
    `)
	if err != nil {
		t.Fatal(err)
	}
	got, err := updatePersonCapacity(ctx, tx, 1, capacityUpdate{50, 40})
	if err != nil || got.WeeklyHours != 50 {
		t.Fatalf("first update: %+v %v", got, err)
	}
	stale, err := updatePersonCapacity(ctx, tx, 1, capacityUpdate{32, 40})
	if !errors.Is(err, errCapacityConflict) || stale.WeeklyHours != 50 {
		t.Fatalf("stale client must conflict: %+v %v", stale, err)
	}
	var persisted float64
	if err := tx.QueryRow(ctx, `SELECT weekly_hours::double precision FROM people WHERE id=1`).Scan(&persisted); err != nil || persisted != 50 {
		t.Fatalf("stale client overwrote capacity: %v %v", persisted, err)
	}
	retry, err := updatePersonCapacity(ctx, tx, 1, capacityUpdate{50, 40})
	if err != nil || retry.WeeklyHours != 50 {
		t.Fatalf("lost-response retry must confirm success: %+v %v", retry, err)
	}
	resolved, err := updatePersonCapacity(ctx, tx, 1, capacityUpdate{32, 50})
	if err != nil || resolved.WeeklyHours != 32 {
		t.Fatalf("explicit conflict resolution: %+v %v", resolved, err)
	}
	zero, err := updatePersonCapacity(ctx, tx, 2, capacityUpdate{20, 0})
	if err != nil || zero.WeeklyHours != 20 {
		t.Fatalf("zero expected capacity: %+v %v", zero, err)
	}
	decimal, err := updatePersonCapacity(ctx, tx, 3, capacityUpdate{40.01, 32.29})
	if err != nil || decimal.WeeklyHours != 40.01 {
		t.Fatalf("decimal compare-and-set: %+v %v", decimal, err)
	}
	decimalConflict, err := updatePersonCapacity(ctx, tx, 3, capacityUpdate{40.02, 32.29})
	if !errors.Is(err, errCapacityConflict) || decimalConflict.WeeklyHours != 40.01 {
		t.Fatalf("decimal stale client: %+v %v", decimalConflict, err)
	}
	_, err = updatePersonCapacity(ctx, tx, 99, capacityUpdate{20, 0})
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("missing person: %v", err)
	}
}
