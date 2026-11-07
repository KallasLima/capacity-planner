package main

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type server struct {
	db *pgxpool.Pool
}

func main() {
	ctx := context.Background()

	// Use an explicit local/demo database; no remote connection is configured in source.
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("Set DATABASE_URL to your local capacity database; see README.md")
	}

	db, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer db.Close()

	// Startup can race database readiness even after the containers have started.
	for i := 0; i < 30; i++ {
		if err = db.Ping(ctx); err == nil {
			break
		}
		time.Sleep(time.Second)
	}
	if err != nil {
		log.Fatalf("ping: %v", err)
	}

	s := &server{db: db}

	// Handlers own validation, compare-and-set checks, and mutation atomicity.
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/capacity", s.handleCapacity)
	mux.HandleFunc("PATCH /api/people/{id}", s.handleUpdatePerson)
	mux.HandleFunc("PATCH /api/people/capacities", s.handleCapacityPlan)
	mux.HandleFunc("GET /api/people/{id}/allocations", s.handleAllocationBreakdown)

	host := os.Getenv("HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "4521"
	}
	parsed, err := strconv.Atoi(port)
	if err != nil || parsed < 1 || parsed > 65535 {
		log.Fatal("PORT must be between 1 and 65535")
	}
	address := net.JoinHostPort(host, port)
	httpServer := &http.Server{Addr: address, Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	log.Printf("Capacity API: http://%s", address)
	log.Fatal(httpServer.ListenAndServe())
}

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	var people int
	if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM people`).Scan(&people); err != nil {
		log.Printf("health query failed: %v", err)
		http.Error(w, "Database unavailable", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "people": people})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
