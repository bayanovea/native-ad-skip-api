package judge

import (
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

// rules decides without a model call on the evidence since the baseline (s.New). A re-cut
// that came without new negative signals goes to a human (a videos row anyone can create
// is no proof; the AI row is served only to players of its own cut anyway); with them the
// LLM judges as usual, so a bogus duration never keeps a row from the judge. No new
// negative signal is ok (a judged video without new evidence never gets here), anything
// else needs the LLM, which sees the totals.
func rules(s Signals) (decision, reason string) {
	if s.New.DurationRecut > 0 && !s.New.negative() {
		return decisionReview, fmt.Sprintf("duration: %d videos rows of another cut requested after publish", s.DurationRecut)
	}
	if !s.New.negative() {
		return decisionOK, "no negative signal"
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
	return needsLLM, strings.Join(neg, " ")
}
