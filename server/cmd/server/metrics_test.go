package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mato-ai/mato/server/internal/analytics"
	"github.com/mato-ai/mato/server/internal/events"
	"github.com/mato-ai/mato/server/internal/realtime"
)

func TestMainRouterDoesNotExposePrometheusMetrics(t *testing.T) {
	router := NewRouter(nil, realtime.NewHub(), events.New(), analytics.NoopClient{}, nil)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("main API /metrics status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}
