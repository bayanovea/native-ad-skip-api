package judge

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Rule outcomes. needsLLM is not a stored decision: the LLM judge takes it.
const (
	decisionOK       = "ok"
	decisionWithdraw = "withdraw"
	decisionReview   = "review"
	needsLLM         = "needs_llm"
)

// rules decides without a model call, given the counters the signals are compared
// against. A re-cut that came without new negative signals goes to a human (a videos
// row anyone can create is no proof; the AI row is served only to players of its own
// cut anyway); with them the LLM judges as usual, so a bogus duration never keeps a
// row from the judge. No negative signal is ok, anything else needs the LLM.
func rules(s Signals, prev Counters) (decision, reason string) {
	if s.DurationRecut > prev.DurationRecut && !negativeGrew(prev, s.Counters) {
		return decisionReview, fmt.Sprintf("duration: %d videos rows of another cut requested after publish", s.DurationRecut)
	}
	var neg []string
	for _, c := range []struct {
		name string
		n    int
	}{{"votes_down", s.VotesDown}, {"undo", s.Undo}, {"conflicting_markups", s.ConflictingMarkups}} {
		if c.n > 0 {
			neg = append(neg, fmt.Sprintf("%s=%d", c.name, c.n))
		}
	}
	if len(neg) == 0 {
		return decisionOK, "no negative signal"
	}
	return needsLLM, strings.Join(neg, " ")
}

// worsened: a negative counter or the re-cut counter grew since prev. Likes, clicks
// and agreeing markups never make a video due again, so a row with one old undo is
// not re-judged on every view.
func worsened(prev, c Counters) bool {
	return negativeGrew(prev, c) || c.DurationRecut > prev.DurationRecut
}

func negativeGrew(prev, c Counters) bool {
	return c.VotesDown > prev.VotesDown || c.Undo > prev.Undo || c.ConflictingMarkups > prev.ConflictingMarkups
}

// storedCounters reads prv_ai_videos.judge_counters; missing or unreadable is zero,
// so every signal counts as new.
func storedCounters(stored []byte) Counters {
	var c Counters
	if json.Unmarshal(stored, &c) != nil {
		return Counters{}
	}
	return c
}
