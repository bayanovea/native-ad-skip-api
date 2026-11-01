package audit

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Severities: owner and backlog reach the owner (page block, Telegram), info stays in the row.
const (
	severityOwner   = "owner"
	severityBacklog = "backlog"
	severityInfo    = "info"
)

// Rule constants (design: Rules in Go).
const (
	minRubberStampVerdicts = 10
	rubberStampGap         = 20 * time.Second
	agreementOwnerBelow    = 0.8
	blindSampleMax         = 12
	wilsonZ                = 1.96
)

// Action is a typed suggestion nothing acts on yet; the hide history tells which ones to automate.
type Action struct {
	Type   string         `json:"type"` // none | blind_subset | backlog_item | eval_import | reviewer_note
	Params map[string]any `json:"params,omitempty"`
	Note   string         `json:"note,omitempty"`
}

type Finding struct {
	Kind     string         `json:"kind"`
	Severity string         `json:"severity"`
	Items    []string       `json:"items"`
	Text     string         `json:"text"`
	Evidence map[string]any `json:"evidence,omitempty"`
	Action   Action         `json:"action"`
	New      bool           `json:"new"`
}

func (f Finding) key() string {
	items := append([]string(nil), f.Items...)
	sort.Strings(items)
	return f.Kind + "|" + strings.Join(items, ",")
}

func (f Finding) pings() bool {
	return f.New && (f.Severity == severityOwner || f.Severity == severityBacklog)
}

// markNew sets New on every finding the previous audit of the batch did not have (same kind, same items).
func markNew(findings, previous []Finding) {
	seen := map[string]bool{}
	for _, p := range previous {
		seen[p.key()] = true
	}
	for i := range findings {
		findings[i].New = !seen[findings[i].key()]
	}
}

func isKeep(v string) bool { return v == "sponsor" || v == "self_promotion" }

// Item sources, from the first flagged_by line (the lines ai/judge, import-below-threshold.js,
// the second opinion and the admin link write) or the item kind.
const (
	sourceSheet  = "sheet"
	sourceJudge  = "judge"
	sourceServed = "served"
	sourceHidden = "hidden"
	sourceSecond = "second"
	sourceAdmin  = "admin"
	sourceOther  = "other"
)

var judgeLine = regexp.MustCompile(`^judge (\S+) by (\S+): (.*)$`)

func itemSource(it item) string {
	if it.Kind != "ai" {
		return sourceSheet
	}
	line := ""
	if len(it.FlaggedBy) > 0 {
		line = it.FlaggedBy[0]
	}
	switch {
	case strings.HasPrefix(line, "judge "):
		return sourceJudge
	case strings.HasPrefix(line, "second "):
		return sourceSecond
	case strings.HasPrefix(line, "admin:"):
		return sourceAdmin
	case strings.HasPrefix(line, "detect run ") && strings.HasSuffix(line, ", served"):
		return sourceServed
	case strings.HasPrefix(line, "detect run ") && strings.Contains(line, ", hidden: "):
		return sourceHidden
	}
	return sourceOther
}

// view is the batch with the derived per-item state the rules share.
type view struct {
	d       *batchData
	latest  map[int]verdict            // item id → latest verdict by anyone
	byRev   map[string]map[int]verdict // reviewer → item id → their latest verdict
	rowsRev map[string][]verdict       // reviewer → their verdict rows, oldest first
}

func newView(d *batchData) *view {
	v := &view{d: d, latest: map[int]verdict{}, byRev: map[string]map[int]verdict{}, rowsRev: map[string][]verdict{}}
	for _, x := range d.Verdicts { // oldest first: later rows overwrite
		v.latest[x.ItemID] = x
		if v.byRev[x.Reviewer] == nil {
			v.byRev[x.Reviewer] = map[int]verdict{}
		}
		v.byRev[x.Reviewer][x.ItemID] = x
		v.rowsRev[x.Reviewer] = append(v.rowsRev[x.Reviewer], x)
	}
	return v
}

// ruleFindings are the fixed-rule findings of the batch, in a stable order.
func ruleFindings(d *batchData) []Finding {
	v := newView(d)
	var out []Finding
	for _, rule := range []func(*view) []Finding{evalReady, judgeFalseAlarm, rubberStamp, precision, agreement, categoryFlip, bounds, trackMismatch} {
		out = append(out, rule(v)...)
	}
	return out
}

func evalReady(v *view) []Finding {
	sheets := map[string]bool{}
	for _, it := range v.d.Items {
		if it.Kind != "ai" {
			sheets[it.Sheet] = true
		}
	}
	var out []Finding
	for _, s := range sortedKeys(sheets) {
		out = append(out, Finding{Kind: "eval_ready", Severity: severityOwner, Items: []string{},
			Text:     fmt.Sprintf("Лист %s размечен: выгрузи вердикты батча %s (export-review-verdicts.sh) и загрузи в eval (adskip review).", s, v.d.Batch),
			Evidence: map[string]any{"sheet": s},
			Action:   Action{Type: "eval_import", Params: map[string]any{"sheet": s, "batch": v.d.Batch}}})
	}
	return out
}

func judgeFalseAlarm(v *view) []Finding {
	type group struct {
		codes        []string
		allKept      bool
		decision, by string
		reason       string
	}
	groups := map[int64]*group{}
	var order []int64
	for _, it := range v.d.Items {
		if itemSource(it) != sourceJudge || !it.VideoID.Valid {
			continue
		}
		g := groups[it.VideoID.Int64]
		if g == nil {
			g = &group{allKept: true}
			if m := judgeLine.FindStringSubmatch(it.FlaggedBy[0]); m != nil {
				g.decision, g.by, g.reason = m[1], m[2], m[3]
			}
			groups[it.VideoID.Int64] = g
			order = append(order, it.VideoID.Int64)
		}
		g.codes = append(g.codes, it.Code)
		if l, ok := v.latest[it.ID]; !ok || !isKeep(l.Verdict) {
			g.allKept = false
		}
	}
	var out []Finding
	for _, id := range order {
		g := groups[id]
		if !g.allKept || (g.decision != "review" && g.decision != "withdraw") {
			continue
		}
		out = append(out, Finding{Kind: "judge_false_alarm", Severity: severityBacklog, Items: g.codes,
			Text: fmt.Sprintf("Судья (%s, %s) отправил видео %d, а асессор оставил все его сегменты. Причина судьи: %s",
				g.decision, g.by, id, g.reason),
			Evidence: map[string]any{"video_id": id, "decision": g.decision, "by": g.by, "reason": g.reason},
			Action:   Action{Type: "backlog_item"}})
	}
	return out
}

func rubberStamp(v *view) []Finding {
	var out []Finding
	for _, rev := range v.d.Finished {
		rows := v.rowsRev[rev]
		if rev == OwnerReviewer || len(rows) < minRubberStampVerdicts {
			continue
		}
		trace := false
		for _, x := range rows {
			if !isKeep(x.Verdict) || x.hasBounds() || strings.TrimSpace(x.Comment) != "" {
				trace = true
				break
			}
		}
		if trace {
			continue
		}
		var gaps []float64
		fast := 0
		for i := 1; i < len(rows); i++ {
			g := rows[i].DecidedAt.Sub(rows[i-1].DecidedAt)
			gaps = append(gaps, g.Seconds())
			if g < rubberStampGap {
				fast++
			}
		}
		med := median(gaps)
		if med >= rubberStampGap.Seconds() {
			continue
		}
		share := float64(fast) / float64(len(gaps))
		sample := min(blindSampleMax, len(v.d.Items))
		out = append(out, Finding{Kind: "rubber_stamp", Severity: severityOwner, Items: []string{},
			Text: fmt.Sprintf("%s: все %d вердиктов — подтверждения без границ и комментариев, медиана %.0f с на пункт (%.0f%% быстрее 20 с). Стоит дать слепую копию другому асессору.",
				rev, len(rows), med, share*100),
			Evidence: map[string]any{"reviewer": rev, "verdicts": len(rows), "median_gap_s": round1(med), "under_20s_share": round2(share)},
			Action:   Action{Type: "blind_subset", Params: map[string]any{"batch": v.d.Batch, "sample": sample, "exclude": rev}}})
	}
	return out
}

func precision(v *view) []Finding {
	type tally struct{ n, keep int }
	per := map[string]*tally{}
	total := tally{}
	var servedWrong []string
	for _, it := range v.d.Items {
		if it.Kind != "ai" {
			continue
		}
		l, ok := v.latest[it.ID]
		if !ok {
			continue
		}
		t := per[it.Proposed]
		if t == nil {
			t = &tally{}
			per[it.Proposed] = t
		}
		t.n++
		total.n++
		if isKeep(l.Verdict) {
			t.keep++
			total.keep++
		} else if itemSource(it) == sourceServed {
			servedWrong = append(servedWrong, it.Code)
		}
	}
	if total.n == 0 {
		return nil
	}
	cats := map[string]any{}
	for c, t := range per {
		cats[c] = map[string]any{"n": t.n, "keep": t.keep, "lower95": round2(wilsonLower(t.keep, t.n))}
	}
	ev := map[string]any{"n": total.n, "keep": total.keep, "share": round2(float64(total.keep) / float64(total.n)),
		"lower95": round2(wilsonLower(total.keep, total.n)), "by_category": cats}
	if len(servedWrong) > 0 {
		return []Finding{{Kind: "precision", Severity: severityOwner, Items: servedWrong,
			Text: fmt.Sprintf("Показанные зрителям сегменты асессор счёл не рекламой: %d из %d (подтверждено %d, нижняя граница 95%% %.0f%%).",
				len(servedWrong), total.n, total.keep, wilsonLower(total.keep, total.n)*100),
			Evidence: ev, Action: Action{Type: "none"}}}
	}
	return []Finding{{Kind: "precision", Severity: severityInfo, Items: []string{},
		Text:     fmt.Sprintf("Подтверждено %d из %d AI-пунктов (нижняя граница 95%% %.0f%%).", total.keep, total.n, wilsonLower(total.keep, total.n)*100),
		Evidence: ev, Action: Action{Type: "none"}}}
}

func agreement(v *view) []Finding {
	if len(v.d.Finished) < 2 {
		return nil
	}
	var differ []string
	for _, it := range v.d.Items {
		first := ""
		for i, rev := range v.d.Finished {
			x := v.byRev[rev][it.ID].Verdict
			if i == 0 {
				first = x
			} else if x != first {
				differ = append(differ, it.Code)
				break
			}
		}
	}
	if len(differ) == 0 {
		return nil
	}
	share := 1 - float64(len(differ))/float64(len(v.d.Items))
	sev := severityInfo
	if share < agreementOwnerBelow {
		sev = severityOwner
	}
	return []Finding{{Kind: "agreement", Severity: sev, Items: differ,
		Text:     fmt.Sprintf("%s расходятся на %d из %d пунктов (согласие %.0f%%).", strings.Join(v.d.Finished, " и "), len(differ), len(v.d.Items), share*100),
		Evidence: map[string]any{"reviewers": v.d.Finished, "differ": len(differ), "items": len(v.d.Items), "agreement": round2(share)},
		Action:   Action{Type: "none"}}}
}

func categoryFlip(v *view) []Finding {
	var codes []string
	dirs := map[string]any{}
	for _, it := range v.d.Items {
		l, ok := v.latest[it.ID]
		if !ok || !isKeep(l.Verdict) || strings.Contains(it.Proposed, "+") || l.Verdict == it.Proposed {
			continue
		}
		codes = append(codes, it.Code)
		k := it.Proposed + "→" + l.Verdict
		n, _ := dirs[k].(int)
		dirs[k] = n + 1
	}
	if len(codes) == 0 {
		return nil
	}
	parts := make([]string, 0, len(dirs))
	for _, k := range sortedKeys(dirs) {
		parts = append(parts, fmt.Sprintf("%s ×%d", k, dirs[k]))
	}
	return []Finding{{Kind: "category_flip", Severity: severityInfo, Items: codes,
		Text: "Категория изменена вердиктом: " + strings.Join(parts, ", ") + ".", Evidence: dirs, Action: Action{Type: "none"}}}
}

func bounds(v *view) []Finding {
	keeps := 0
	var with []string
	for _, it := range v.d.Items {
		l, ok := v.latest[it.ID]
		if !ok || !isKeep(l.Verdict) {
			continue
		}
		keeps++
		if l.hasBounds() {
			with = append(with, it.Code)
		}
	}
	if keeps == 0 {
		return nil
	}
	return []Finding{{Kind: "bounds", Severity: severityInfo, Items: orEmpty(with),
		Text:     fmt.Sprintf("Границы поправлены в %d из %d подтверждений.", len(with), keeps),
		Evidence: map[string]any{"keeps": keeps, "with_bounds": len(with)}, Action: Action{Type: "none"}}}
}

func trackMismatch(v *view) []Finding {
	var codes []string
	for _, it := range v.d.Items {
		if v.d.Track[it.NativeID] {
			codes = append(codes, it.Code)
		}
	}
	if len(codes) == 0 {
		return nil
	}
	return []Finding{{Kind: "track_mismatch", Severity: severityInfo, Items: codes,
		Text:     fmt.Sprintf("Отмечено «дорожка субтитров ≠ видео»: %d пунктов.", len(codes)),
		Evidence: map[string]any{"items": len(codes)}, Action: Action{Type: "none"}}}
}

// metrics is the batch's numbers recorded next to the findings.
func metrics(d *batchData) map[string]any {
	v := newView(d)
	verdicts := map[string]int{}
	matrix := map[string]map[string]int{}
	sources := map[string]int{}
	comments, withBounds := 0, 0
	for _, it := range d.Items {
		sources[itemSource(it)]++
		l, ok := v.latest[it.ID]
		if !ok {
			continue
		}
		verdicts[l.Verdict]++
		if matrix[it.Proposed] == nil {
			matrix[it.Proposed] = map[string]int{}
		}
		matrix[it.Proposed][l.Verdict]++
		if strings.TrimSpace(l.Comment) != "" {
			comments++
		}
		if l.hasBounds() {
			withBounds++
		}
	}
	pace := map[string]any{}
	for rev, rows := range v.rowsRev {
		var gaps []float64
		for i := 1; i < len(rows); i++ {
			gaps = append(gaps, rows[i].DecidedAt.Sub(rows[i-1].DecidedAt).Seconds())
		}
		pace[rev] = map[string]any{"verdicts": len(rows), "median_gap_s": round1(median(gaps))}
	}
	return map[string]any{"items": len(d.Items), "reviews_needed": d.ReviewsNeeded, "finished": d.Finished,
		"verdicts": verdicts, "proposed_x_verdict": matrix, "sources": sources, "comments": comments,
		"with_bounds": withBounds, "pace": pace}
}

// wilsonLower is the lower bound of the Wilson score interval for k of n at 95 %.
func wilsonLower(k, n int) float64 {
	if n == 0 {
		return 0
	}
	p, nf, z2 := float64(k)/float64(n), float64(n), wilsonZ*wilsonZ
	return (p + z2/(2*nf) - wilsonZ*math.Sqrt(p*(1-p)/nf+z2/(4*nf*nf))) / (1 + z2/nf)
}

func median(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	if len(s)%2 == 1 {
		return s[len(s)/2]
	}
	return (s[len(s)/2-1] + s[len(s)/2]) / 2
}

func round1(x float64) float64 { return math.Round(x*10) / 10 }
func round2(x float64) float64 { return math.Round(x*100) / 100 }

func orEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
