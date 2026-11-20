// Package budget paces the AI pipeline's model spend against each vendor's monthly
// allowance (AI_BUDGET_ENABLED): spend is the product's own recorded cost, today's cap
// spreads what is left of the usable amount over the days to the reset.
package budget

import (
	"database/sql"
	"fmt"
	"math"
	"strings"
	"time"
)

const (
	Anthropic = "anthropic"
	OpenAI    = "openai"
)

// VendorOf is the one rule for which API serves a model id.
func VendorOf(model string) string {
	if strings.HasPrefix(model, "claude-") {
		return Anthropic
	}
	return OpenAI
}

// Cycle is the allowance cycle holding now: from 00:00 UTC on the reset day to the next one.
func Cycle(now time.Time, resetDay int) (start, end time.Time) {
	now = now.UTC()
	start = time.Date(now.Year(), now.Month(), resetDay, 0, 0, 0, 0, time.UTC)
	if now.Before(start) {
		start = start.AddDate(0, -1, 0)
	}
	return start, start.AddDate(0, 1, 0)
}

// fallbackCost prices a call when the vendor has no priced call of that kind yet.
const fallbackCost = 0.02

// Vendor is one vendor's state for a tick.
type Vendor struct {
	VendorConfig
	Usable      float64 // the allowance less the reserve
	Start, End  time.Time
	SpentBefore float64 // this cycle before today (UTC)
	SpentToday  float64 // today, plus what this tick added
	SpentWeek   float64 // the last 7 days, for the forecast
	Cap         float64 // today's cap
	AvgDetect   float64 // a detector run, over the vendor's last 200 priced ones
	AvgConfirm  float64 // a second-opinion call, likewise
}

// State is every vendor's Vendor, loaded once at tick start.
type State struct {
	Reserve float64
	Vendors map[string]*Vendor
	now     time.Time
}

// Load reads every vendor's spend and computes today's cap. A detector run still waiting
// for its batch (no cost yet, younger than the 24 h expiry) counts at the vendor's average.
func Load(db *sql.DB, cfg Config, now time.Time) (*State, error) {
	now = now.UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	s := &State{Reserve: cfg.Reserve, Vendors: map[string]*Vendor{}, now: now}
	for _, vc := range cfg.Vendors {
		v := &Vendor{VendorConfig: vc, Usable: vc.Allowance * (1 - cfg.Reserve)}
		v.Start, v.End = Cycle(now, vc.ResetDay)
		anthropic := vc.Name == Anthropic
		var detect, confirm sql.NullFloat64
		if err := db.QueryRow(`SELECT
			(SELECT AVG(cost_usd) FROM (SELECT cost_usd FROM prv_ai_runs
				WHERE cost_usd > 0 AND (model LIKE 'claude-%') = $1 ORDER BY id DESC LIMIT 200) r),
			(SELECT AVG(cost_usd) FROM (SELECT cost_usd FROM prv_ai_confirmations
				WHERE cost_usd > 0 AND (model LIKE 'claude-%') = $1 ORDER BY id DESC LIMIT 200) c)`, anthropic).
			Scan(&detect, &confirm); err != nil {
			return nil, fmt.Errorf("%s average cost: %w", vc.Name, err)
		}
		v.AvgDetect, v.AvgConfirm = fallbackCost, fallbackCost
		if detect.Valid {
			v.AvgDetect = detect.Float64
		}
		if confirm.Valid {
			v.AvgConfirm = confirm.Float64
		}
		week := now.Add(-7 * 24 * time.Hour)
		since := v.Start
		if week.Before(since) {
			since = week
		}
		if err := db.QueryRow(`WITH calls AS (
				SELECT model, COALESCE(cost_usd, CASE WHEN created_at > $4::timestamptz - INTERVAL '24 hours' THEN $5::float8 END) AS cost,
					created_at FROM prv_ai_runs WHERE created_at >= $6
				UNION ALL SELECT model, cost_usd, created_at FROM prv_ai_confirmations WHERE created_at >= $6
				UNION ALL SELECT model, cost_usd, created_at FROM prv_ai_judgements WHERE created_at >= $6
				UNION ALL SELECT model, cost_usd, created_at FROM prv_review_audits WHERE created_at >= $6)
			SELECT COALESCE(SUM(cost) FILTER (WHERE created_at >= $1 AND created_at < $2), 0),
				COALESCE(SUM(cost) FILTER (WHERE created_at >= $2), 0),
				COALESCE(SUM(cost) FILTER (WHERE created_at >= $3), 0)
			FROM calls WHERE (model LIKE 'claude-%') = $7`,
			v.Start, today, week, now, v.AvgDetect, since, anthropic).
			Scan(&v.SpentBefore, &v.SpentToday, &v.SpentWeek); err != nil {
			return nil, fmt.Errorf("%s spend: %w", vc.Name, err)
		}
		days := math.Ceil(v.End.Sub(today).Hours() / 24)
		v.Cap = max(v.Usable-v.SpentBefore, 0) / days
		s.Vendors[vc.Name] = v
	}
	return s, nil
}

// Raise adds usd to the vendor's cap for today, at most up to what is left of its usable
// amount; the days after pay it back through the cap formula.
func (s *State) Raise(vendor string, usd float64) {
	if v := s.Vendors[vendor]; v != nil {
		v.Cap = min(v.Cap+usd, max(v.Usable-v.SpentBefore, 0))
	}
}

// Room is how many more calls at cost each the vendor's cap pays for today.
func (s *State) Room(vendor string, cost float64) int {
	v := s.Vendors[vendor]
	if v == nil {
		return 0
	}
	left := v.Cap - v.SpentToday
	if left <= 0 {
		return 0
	}
	if cost <= 0 {
		return math.MaxInt
	}
	return int(math.Floor(left/cost + 1e-9))
}

// Allow tells whether one more call at cost stays within the vendor's cap today.
func (s *State) Allow(vendor string, cost float64) bool {
	return s.Room(vendor, cost) >= 1
}

// Spend adds a call made this tick (or a correction of an estimate) to today's spend.
func (s *State) Spend(vendor string, cost float64) {
	if v := s.Vendors[vendor]; v != nil {
		v.SpentToday += cost
		v.SpentWeek += cost
	}
}

// Save upserts one prv_ai_budgets row per vendor; backlog is the confirmation backlog by
// the vendor that works it (absent = NULL). The forecast is what the last 7 days' pace
// leaves of the usable amount at the reset.
func (s *State) Save(db *sql.DB, backlog map[string]int) error {
	for name, v := range s.Vendors {
		spent := v.SpentBefore + v.SpentToday
		forecast := v.Usable - spent - v.SpentWeek/7*v.End.Sub(s.now).Hours()/24
		var b any
		if n, ok := backlog[name]; ok {
			b = n
		}
		if _, err := db.Exec(`INSERT INTO prv_ai_budgets (vendor, allowance_usd, reserve, cycle_start, cycle_end,
				spent_cycle_usd, spent_today_usd, cap_today_usd, forecast_unspent_usd, backlog, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
			ON CONFLICT (vendor) DO UPDATE SET allowance_usd = EXCLUDED.allowance_usd, reserve = EXCLUDED.reserve,
				cycle_start = EXCLUDED.cycle_start, cycle_end = EXCLUDED.cycle_end, spent_cycle_usd = EXCLUDED.spent_cycle_usd,
				spent_today_usd = EXCLUDED.spent_today_usd, cap_today_usd = EXCLUDED.cap_today_usd,
				forecast_unspent_usd = EXCLUDED.forecast_unspent_usd, backlog = EXCLUDED.backlog, updated_at = NOW()`,
			name, v.Allowance, s.Reserve, v.Start, v.End, spent, v.SpentToday, v.Cap, forecast, b); err != nil {
			return fmt.Errorf("%s budget state: %w", name, err)
		}
	}
	return nil
}
