package audit

import (
	"database/sql"
	"fmt"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)

// aiItems: n ai items of video 7 with the first flagged_by line, codes <prefix>1…
func aiItems(prefix, line string, n int, proposed string) []item {
	var out []item
	for i := 1; i <= n; i++ {
		out = append(out, item{ID: i, Code: fmt.Sprintf("%s%d", prefix, i), Kind: "ai", Sheet: "s", NativeID: fmt.Sprintf("-1_%d", i),
			VideoID: sql.NullInt64{Int64: 7, Valid: true}, Start: 10, End: 40, Proposed: proposed, FlaggedBy: []string{line}})
	}
	return out
}

// verdicts: one verdict per item by rev, gap apart, starting at t0.
func verdicts(rev string, items []item, value string, gap time.Duration, firstID int) []verdict {
	var out []verdict
	for i, it := range items {
		out = append(out, verdict{ID: firstID + i, ItemID: it.ID, Verdict: value, Reviewer: rev, DecidedAt: t0.Add(time.Duration(i) * gap)})
	}
	return out
}

func kinds(fs []Finding) map[string]Finding {
	m := map[string]Finding{}
	for _, f := range fs {
		m[f.Kind] = f
	}
	return m
}

func TestEvalReadyOnSheetItems(t *testing.T) {
	its := []item{{ID: 1, Code: "C1", Kind: "sheet", Sheet: "2026-11-01-x", Proposed: "sponsor"}}
	d := &batchData{Batch: "2026-11-01-x-p1", Finished: []string{"Gam"}, Items: its, Verdicts: verdicts("Gam", its, "not_ad", time.Minute, 1)}
	f, ok := kinds(ruleFindings(d))["eval_ready"]
	if !ok || f.Severity != severityOwner || f.Action.Type != "eval_import" || f.Evidence["sheet"] != "2026-11-01-x" {
		t.Fatalf("eval_ready = %+v", f)
	}
	if _, ok := kinds(ruleFindings(d))["precision"]; ok {
		t.Fatal("precision on a sheet batch")
	}
}

func TestJudgeFalseAlarm(t *testing.T) {
	its := aiItems("A", "judge review by rules: duration: 1 videos rows of another cut", 2, "sponsor")
	d := &batchData{Batch: "ai-judge-2026-11-01", Finished: []string{"Gam"}, Items: its, Verdicts: verdicts("Gam", its, "sponsor", time.Minute, 1)}
	f, ok := kinds(ruleFindings(d))["judge_false_alarm"]
	if !ok || f.Severity != severityBacklog || len(f.Items) != 2 || f.Evidence["by"] != "rules" || f.Evidence["decision"] != "review" {
		t.Fatalf("judge_false_alarm = %+v", f)
	}
	d.Verdicts[1].Verdict = "not_ad"
	if _, ok := kinds(ruleFindings(d))["judge_false_alarm"]; ok {
		t.Fatal("a not_ad on one entry is no false alarm")
	}
}

func TestRubberStamp(t *testing.T) {
	its := aiItems("S", "detect run 1: sponsor high, 30 s, served", 12, "sponsor")
	d := &batchData{Batch: "ai-served-p1", Finished: []string{"Gam"}, Items: its, Verdicts: verdicts("Gam", its, "sponsor", 13*time.Second, 1)}
	f, ok := kinds(ruleFindings(d))["rubber_stamp"]
	if !ok || f.Severity != severityOwner || f.Action.Type != "blind_subset" || f.Action.Params["sample"] != 12 || f.Evidence["median_gap_s"] != 13.0 {
		t.Fatalf("rubber_stamp = %+v", f)
	}
	for name, change := range map[string]func(*batchData){
		"slow":      func(d *batchData) { d.Verdicts = verdicts("Gam", its, "sponsor", 25*time.Second, 1) },
		"a comment": func(d *batchData) { d.Verdicts[3].Comment = "интеграция" },
		"bounds": func(d *batchData) {
			d.Verdicts[3].Start, d.Verdicts[3].End = sql.NullInt64{Int64: 1, Valid: true}, sql.NullInt64{Int64: 9, Valid: true}
		},
		"a not_ad": func(d *batchData) { d.Verdicts[3].Verdict = "not_ad" },
		"the owner": func(d *batchData) {
			d.Finished = []string{OwnerReviewer}
			d.Verdicts = verdicts(OwnerReviewer, its, "sponsor", time.Second, 1)
		},
		"few": func(d *batchData) {
			d.Items = its[:9]
			d.Verdicts = verdicts("Gam", its[:9], "sponsor", time.Second, 1)
		},
	} {
		c := *d
		c.Verdicts = append([]verdict(nil), d.Verdicts...)
		change(&c)
		if _, ok := kinds(ruleFindings(&c))["rubber_stamp"]; ok {
			t.Errorf("%s: rubber_stamp", name)
		}
	}
}

func TestPrecision(t *testing.T) {
	its := aiItems("S", "detect run 1: sponsor high, 30 s, served", 4, "sponsor")
	d := &batchData{Batch: "ai-served-p1", Finished: []string{"Gam"}, Items: its, Verdicts: verdicts("Gam", its, "sponsor", time.Minute, 1)}
	f := kinds(ruleFindings(d))["precision"]
	if f.Severity != severityInfo || f.Evidence["keep"] != 4 {
		t.Fatalf("all kept: %+v", f)
	}
	d.Verdicts[2].Verdict = "unclear"
	f = kinds(ruleFindings(d))["precision"]
	if f.Severity != severityOwner || len(f.Items) != 1 || f.Items[0] != "S3" {
		t.Fatalf("a served unclear: %+v", f)
	}
	// Below-threshold items judged not an ad were never served: info.
	hid := aiItems("B", "detect run 1: sponsor low, 8 s, hidden: confidence", 2, "sponsor")
	d = &batchData{Batch: "b", Finished: []string{"Gam"}, Items: hid, Verdicts: verdicts("Gam", hid, "not_ad", time.Minute, 1)}
	if f := kinds(ruleFindings(d))["precision"]; f.Severity != severityInfo {
		t.Fatalf("hidden not_ad: %+v", f)
	}
}

func TestAgreement(t *testing.T) {
	its := aiItems("A", "judge review by llm: x", 5, "sponsor")
	vs := append(verdicts("Gam", its, "sponsor", time.Minute, 1), verdicts("Ann", its, "sponsor", time.Minute, 10)...)
	d := &batchData{Batch: "b", ReviewsNeeded: 2, Finished: []string{"Ann", "Gam"}, Items: its, Verdicts: vs}
	if _, ok := kinds(ruleFindings(d))["agreement"]; ok {
		t.Fatal("agreement finding without a difference")
	}
	d.Verdicts[len(d.Verdicts)-1].Verdict = "not_ad"
	if f := kinds(ruleFindings(d))["agreement"]; f.Severity != severityInfo || f.Items[0] != "A5" {
		t.Fatalf("4 of 5: %+v", f)
	}
	d.Verdicts[len(d.Verdicts)-2].Verdict = "not_ad"
	if f := kinds(ruleFindings(d))["agreement"]; f.Severity != severityOwner {
		t.Fatalf("3 of 5: %+v", f)
	}
}

func TestCategoryFlipBoundsTrack(t *testing.T) {
	its := aiItems("A", "judge review by llm: x", 3, "self_promotion")
	its[2].Proposed = "sponsor+self_promotion"
	vs := verdicts("Gam", its, "sponsor", time.Minute, 1)
	vs[1].Verdict = "self_promotion"
	vs[1].Start, vs[1].End = sql.NullInt64{Int64: 5, Valid: true}, sql.NullInt64{Int64: 30, Valid: true}
	d := &batchData{Batch: "b", Finished: []string{"Gam"}, Items: its, Verdicts: vs, Track: map[string]bool{"-1_2": true}}
	k := kinds(ruleFindings(d))
	if f := k["category_flip"]; len(f.Items) != 1 || f.Items[0] != "A1" || f.Evidence["self_promotion→sponsor"] != 1 {
		t.Fatalf("category_flip = %+v", f)
	}
	if f := k["bounds"]; f.Evidence["keeps"] != 3 || f.Evidence["with_bounds"] != 1 {
		t.Fatalf("bounds = %+v", f)
	}
	if f := k["track_mismatch"]; len(f.Items) != 1 || f.Items[0] != "A2" {
		t.Fatalf("track_mismatch = %+v", f)
	}
}

func TestNoConditionNoFinding(t *testing.T) {
	its := []item{{ID: 1, Code: "A1", Kind: "ai", Proposed: "sponsor", FlaggedBy: []string{"judge withdraw by llm: x"}}}
	d := &batchData{Batch: "b", Finished: []string{"Gam"}, Items: its, Verdicts: verdicts("Gam", its, "not_ad", time.Minute, 1)}
	for _, f := range ruleFindings(d) {
		if f.Kind != "precision" {
			t.Errorf("unexpected %s", f.Kind)
		}
	}
}

func TestMarkNew(t *testing.T) {
	prev := []Finding{{Kind: "agreement", Items: []string{"A2", "A1"}}}
	cur := []Finding{{Kind: "agreement", Items: []string{"A1", "A2"}}, {Kind: "agreement", Items: []string{"A1"}}, {Kind: "bounds"}}
	markNew(cur, prev)
	if cur[0].New || !cur[1].New || !cur[2].New {
		t.Fatalf("new = %v %v %v", cur[0].New, cur[1].New, cur[2].New)
	}
}

func TestWilsonLower(t *testing.T) {
	if got := round2(wilsonLower(50, 50)); got != 0.93 {
		t.Fatalf("50/50 lower = %v", got)
	}
	if wilsonLower(0, 0) != 0 {
		t.Fatal("0/0")
	}
}
