package pipeline

import "testing"

func TestConfigFromEnvDefaultsOff(t *testing.T) {
	for _, k := range []string{"AI_DETECT_ENABLED", "AI_MIN_VIEWS", "AI_FALLBACK_REQUESTS", "AI_DAILY_BUDGET_VIDEOS", "AI_BATCH_MAX", "AI_MODEL", "AI_CLIENT"} {
		t.Setenv(k, "")
	}
	c, err := ConfigFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	want := Config{MinViews: 10000, FallbackRequests: 3, DailyBudget: 200, BatchMax: 100, Model: "claude-sonnet-5-5", Client: "anthropic"}
	if c.DetectEnabled || c.MinViews != want.MinViews || c.FallbackRequests != want.FallbackRequests ||
		c.DailyBudget != want.DailyBudget || c.BatchMax != want.BatchMax || c.Model != want.Model || c.Client != want.Client {
		t.Fatalf("got %+v", c)
	}

	t.Setenv("AI_DETECT_ENABLED", "on")
	t.Setenv("AI_MIN_VIEWS", "500")
	if c, err = ConfigFromEnv(); err != nil || !c.DetectEnabled || c.MinViews != 500 {
		t.Fatalf("got %+v, %v", c, err)
	}
	t.Setenv("AI_BATCH_MAX", "ten")
	if _, err := ConfigFromEnv(); err == nil {
		t.Fatal("bad integer: want an error")
	}
}
