package budget

import (
	"math"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func day(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestCycle(t *testing.T) {
	for _, c := range []struct {
		now        string
		reset      int
		start, end string
	}{
		{"2026-11-19T12:00:00Z", 10, "2026-11-10T00:00:00Z", "2026-12-10T00:00:00Z"},
		{"2026-12-05T12:00:00Z", 19, "2026-11-19T00:00:00Z", "2026-12-19T00:00:00Z"},
		{"2026-11-10T00:00:00Z", 10, "2026-11-10T00:00:00Z", "2026-12-10T00:00:00Z"}, // the reset instant opens the new cycle
		{"2026-11-09T23:59:59Z", 10, "2026-10-10T00:00:00Z", "2026-11-10T00:00:00Z"},
		{"2026-12-20T08:00:00Z", 10, "2026-12-10T00:00:00Z", "2027-01-10T00:00:00Z"},
		{"2027-01-05T08:00:00Z", 10, "2026-12-10T00:00:00Z", "2027-01-10T00:00:00Z"},
		{"2026-11-19T03:00:00+07:00", 19, "2026-10-19T00:00:00Z", "2026-11-19T00:00:00Z"}, // UTC, not local time
	} {
		start, end := Cycle(day(c.now), c.reset)
		if !start.Equal(day(c.start)) || !end.Equal(day(c.end)) {
			t.Errorf("Cycle(%s, %d) = %s – %s, want %s – %s", c.now, c.reset, start, end, c.start, c.end)
		}
	}
}

func TestVendorOf(t *testing.T) {
	if VendorOf("claude-haiku-5-5") != Anthropic || VendorOf("gpt-6.1-terra") != OpenAI {
		t.Fatal("vendor rule")
	}
}

func setEnv(t *testing.T, vars map[string]string) {
	for _, k := range []string{"AI_BUDGET_ENABLED", "AI_BUDGET_RESERVE", "AI_BUDGET_OPENAI_USD", "AI_BUDGET_OPENAI_RESET_DAY",
		"AI_BUDGET_ANTHROPIC_USD", "AI_BUDGET_ANTHROPIC_RESET_DAY"} {
		t.Setenv(k, vars[k])
	}
}

var fullEnv = map[string]string{"AI_BUDGET_ENABLED": "on", "AI_BUDGET_OPENAI_USD": "200", "AI_BUDGET_OPENAI_RESET_DAY": "10",
	"AI_BUDGET_ANTHROPIC_USD": "100", "AI_BUDGET_ANTHROPIC_RESET_DAY": "19"}

func TestConfigFromEnv(t *testing.T) {
	setEnv(t, map[string]string{"AI_BUDGET_OPENAI_USD": "nonsense"})
	if c, err := ConfigFromEnv(); err != nil || c.Enabled {
		t.Fatalf("off: the others are not read, got %+v %v", c, err)
	}

	setEnv(t, fullEnv)
	c, err := ConfigFromEnv()
	if err != nil || !c.Enabled || c.Reserve != 0.1 || len(c.Vendors) != 2 ||
		c.Vendors[0] != (VendorConfig{OpenAI, 200, 10}) || c.Vendors[1] != (VendorConfig{Anthropic, 100, 19}) {
		t.Fatalf("got %+v %v", c, err)
	}

	for name, bad := range map[string]string{"AI_BUDGET_ANTHROPIC_USD": "", "AI_BUDGET_OPENAI_RESET_DAY": "29",
		"AI_BUDGET_ANTHROPIC_RESET_DAY": "0", "AI_BUDGET_OPENAI_USD": "-5", "AI_BUDGET_RESERVE": "1"} {
		env := map[string]string{}
		for k, v := range fullEnv {
			env[k] = v
		}
		env[name] = bad
		setEnv(t, env)
		if _, err := ConfigFromEnv(); err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("%s=%q: want an error naming it, got %v", name, bad, err)
		}
	}
}

func expectVendor(mock sqlmock.Sqlmock, anthropic bool, avgDetect, avgConfirm any, before, today, week float64) {
	mock.ExpectQuery(`(?s)FROM prv_ai_runs\s+WHERE cost_usd > 0 .*ORDER BY id DESC LIMIT 200.*FROM prv_ai_confirmations`).
		WithArgs(anthropic).
		WillReturnRows(sqlmock.NewRows([]string{"detect", "confirm"}).AddRow(avgDetect, avgConfirm))
	mock.ExpectQuery(`(?s)COALESCE\(cost_usd, CASE WHEN created_at > \$4::timestamptz - INTERVAL '24 hours' THEN \$5::float8 END\).*FROM prv_ai_runs`+
		`.*FROM prv_ai_confirmations.*FROM prv_ai_judgements.*FROM prv_review_audits.*`+
		regexp.QuoteMeta(`FROM calls WHERE (model LIKE 'claude-%') = $7`)).
		WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), anthropic).
		WillReturnRows(sqlmock.NewRows([]string{"before", "today", "week"}).AddRow(before, today, week))
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-6 }

func TestLoadEvenPace(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := day("2026-11-19T15:00:00Z")
	cfg := Config{Enabled: true, Reserve: 0.1, Vendors: []VendorConfig{{OpenAI, 200, 10}, {Anthropic, 100, 19}}}

	// OpenAI: $16 before today; the spend query gets the cycle start, today's midnight, the week, now,
	// the average a run in flight counts at, and the earliest of cycle start and week.
	mock.ExpectQuery(`FROM prv_ai_runs`).WithArgs(false).
		WillReturnRows(sqlmock.NewRows([]string{"detect", "confirm"}).AddRow(0.012, nil))
	mock.ExpectQuery(`WITH calls AS`).
		WithArgs(day("2026-11-10T00:00:00Z"), day("2026-11-19T00:00:00Z"), day("2026-11-12T15:00:00Z"), now, 0.012,
			day("2026-11-10T00:00:00Z"), false).
		WillReturnRows(sqlmock.NewRows([]string{"before", "today", "week"}).AddRow(16.0, 7.78, 40.0))
	// Anthropic: no priced call yet (the $0.02 fallback); the cycle started today, so the week reaches further back.
	mock.ExpectQuery(`FROM prv_ai_runs`).WithArgs(true).
		WillReturnRows(sqlmock.NewRows([]string{"detect", "confirm"}).AddRow(nil, nil))
	mock.ExpectQuery(`WITH calls AS`).
		WithArgs(day("2026-11-19T00:00:00Z"), day("2026-11-19T00:00:00Z"), day("2026-11-12T15:00:00Z"), now, fallbackCost,
			day("2026-11-12T15:00:00Z"), true).
		WillReturnRows(sqlmock.NewRows([]string{"before", "today", "week"}).AddRow(0.0, 0.0, 3.0))

	s, err := Load(db, cfg, now)
	if err != nil {
		t.Fatal(err)
	}
	o, a := s.Vendors[OpenAI], s.Vendors[Anthropic]
	if !near(o.Usable, 180) || !near(o.Cap, (180-16)/21.0) || o.AvgDetect != 0.012 || o.AvgConfirm != fallbackCost {
		t.Fatalf("openai %+v", o)
	}
	if !near(a.Usable, 90) || !near(a.Cap, 90/30.0) || a.AvgDetect != fallbackCost || a.AvgConfirm != fallbackCost {
		t.Fatalf("anthropic %+v", a)
	}
	// $7.81 cap, $7.78 spent, $0.012 a run: room for two.
	if n := s.Room(OpenAI, o.AvgDetect); n != 2 {
		t.Fatalf("room %d, want 2", n)
	}
	s.Spend(OpenAI, 0.03)
	if s.Room(OpenAI, o.AvgDetect) != 0 || s.Allow(OpenAI, 0.001) {
		t.Fatal("the cap spent leaves no room")
	}
	if !s.Allow(Anthropic, a.AvgConfirm) || s.Room("other", 1) != 0 {
		t.Fatal("allow")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestLoadOverspent(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	expectVendor(mock, true, 0.0037, 0.004, 95, 1, 10)
	s, err := Load(db, Config{Enabled: true, Reserve: 0.1, Vendors: []VendorConfig{{Anthropic, 100, 19}}}, day("2026-12-05T10:00:00Z"))
	if err != nil {
		t.Fatal(err)
	}
	if v := s.Vendors[Anthropic]; v.Cap != 0 || s.Allow(Anthropic, 0.004) {
		t.Fatalf("overspent: cap %v", v.Cap)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestSave(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := day("2026-11-19T12:00:00Z")
	s := &State{Reserve: 0.1, now: now, Vendors: map[string]*Vendor{
		Anthropic: {VendorConfig: VendorConfig{Anthropic, 100, 19}, Usable: 90, Start: day("2026-11-19T00:00:00Z"),
			End: day("2026-12-19T00:00:00Z"), SpentBefore: 0, SpentToday: 1.5, SpentWeek: 7, Cap: 3},
	}}
	// forecast: 90 − 1.5 − 7/7 a day × 29.5 days left
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO prv_ai_budgets")+`(?s).*ON CONFLICT \(vendor\) DO UPDATE`).
		WithArgs(Anthropic, 100.0, 0.1, day("2026-11-19T00:00:00Z"), day("2026-12-19T00:00:00Z"), 1.5, 1.5, 3.0, 59.0, 4321).
		WillReturnResult(sqlmock.NewResult(0, 1))
	if err := s.Save(db, map[string]int{Anthropic: 4321}); err != nil {
		t.Fatal(err)
	}
	s.Vendors = map[string]*Vendor{OpenAI: {VendorConfig: VendorConfig{OpenAI, 200, 10}, Usable: 180,
		Start: day("2026-11-10T00:00:00Z"), End: day("2026-12-10T00:00:00Z")}}
	mock.ExpectExec("INSERT INTO prv_ai_budgets").
		WithArgs(OpenAI, 200.0, 0.1, sqlmock.AnyArg(), sqlmock.AnyArg(), 0.0, 0.0, 0.0, 180.0, nil).
		WillReturnResult(sqlmock.NewResult(0, 1))
	if err := s.Save(db, map[string]int{Anthropic: 1}); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
