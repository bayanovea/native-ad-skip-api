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

// rules decides without a model call: a re-cut video is withdrawn (its AI row is
// timed for the old cut), no negative signal is ok, anything else needs the LLM.
func rules(s Signals) (decision, reason string) {
	if s.DurationRecut > 0 {
		return decisionWithdraw, fmt.Sprintf("duration: %d videos rows of another cut requested after publish", s.DurationRecut)
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

// moved: the counters differ from the ones stored at the last judgement (a
// missing or unreadable record counts as moved).
func moved(stored []byte, c Counters) bool {
	var prev Counters
	if len(stored) == 0 || json.Unmarshal(stored, &prev) != nil {
		return true
	}
	return prev != c
}
