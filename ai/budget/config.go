package budget

import (
	"fmt"
	"os"
	"strconv"
)

// Config is the spend budget's environment. Off unless AI_BUDGET_ENABLED=on; the other
// variables are read only then.
type Config struct {
	Enabled bool
	Reserve float64 // AI_BUDGET_RESERVE: the share of each allowance never planned for
	Backlog float64 // AI_BUDGET_BACKLOG_USD: added to today's cap of the vendor working the confirmation backlog
	Vendors []VendorConfig
}

// VendorConfig is one vendor's monthly allowance.
type VendorConfig struct {
	Name      string
	Allowance float64 // AI_BUDGET_<VENDOR>_USD
	ResetDay  int     // AI_BUDGET_<VENDOR>_RESET_DAY, 1–28: every month has it
}

func ConfigFromEnv() (Config, error) {
	c := Config{Enabled: os.Getenv("AI_BUDGET_ENABLED") == "on", Reserve: 0.1}
	if !c.Enabled {
		return c, nil
	}
	if s := os.Getenv("AI_BUDGET_RESERVE"); s != "" {
		r, err := strconv.ParseFloat(s, 64)
		if err != nil || r < 0 || r >= 1 {
			return c, fmt.Errorf("AI_BUDGET_RESERVE must be a share in [0, 1), got %q", s)
		}
		c.Reserve = r
	}
	if s := os.Getenv("AI_BUDGET_BACKLOG_USD"); s != "" {
		b, err := strconv.ParseFloat(s, 64)
		if err != nil || b < 0 {
			return c, fmt.Errorf("AI_BUDGET_BACKLOG_USD must be an amount ≥ 0, got %q", s)
		}
		c.Backlog = b
	}
	for _, v := range []struct{ name, prefix string }{{OpenAI, "AI_BUDGET_OPENAI"}, {Anthropic, "AI_BUDGET_ANTHROPIC"}} {
		usd, day := v.prefix+"_USD", v.prefix+"_RESET_DAY"
		a, err := strconv.ParseFloat(os.Getenv(usd), 64)
		if err != nil || a <= 0 {
			return c, fmt.Errorf("%s must be a positive amount with AI_BUDGET_ENABLED=on, got %q", usd, os.Getenv(usd))
		}
		d, err := strconv.Atoi(os.Getenv(day))
		if err != nil || d < 1 || d > 28 {
			return c, fmt.Errorf("%s must be a day 1–28 with AI_BUDGET_ENABLED=on, got %q", day, os.Getenv(day))
		}
		c.Vendors = append(c.Vendors, VendorConfig{Name: v.name, Allowance: a, ResetDay: d})
	}
	return c, nil
}
