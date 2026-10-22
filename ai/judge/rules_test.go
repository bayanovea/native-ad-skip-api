package judge

import "testing"

func TestRules(t *testing.T) {
	recut := "duration: 1 videos rows of another cut requested after publish"
	cases := []struct {
		name     string
		c        Counters
		new      Evidence
		decision string
		reason   string
	}{
		{"no signals", Counters{}, Evidence{}, decisionOK, "no negative signal"},
		{"likes, clicks and agreeing markups are not negative", Counters{VotesUp: 5, Clicks: 9, HumanMarkups: 2}, Evidence{}, decisionOK, "no negative signal"},
		{"old split rows alone are not a re-cut", Counters{DurationVariants: 3}, Evidence{}, decisionOK, "no negative signal"},
		{"dislikes", Counters{VotesDown: 2}, Evidence{VotesDown: 2}, needsLLM, "votes_down=2"},
		{"undo", Counters{Undo: 1}, Evidence{Undo: 1}, needsLLM, "undo=1"},
		{"conflicting markup", Counters{HumanMarkups: 1, ConflictingMarkups: 1}, Evidence{ConflictingMarkups: 1}, needsLLM, "conflicting_markups=1"},
		{"the LLM sees the totals", Counters{VotesDown: 1, Undo: 3}, Evidence{Undo: 1}, needsLLM, "votes_down=1 undo=3"},
		// Entry A's three dislikes are gone with A (removed on review), B has two new ones: fewer than before, still new.
		{"new dislikes after the total shrank", Counters{VotesDown: 2}, Evidence{VotesDown: 2}, needsLLM, "votes_down=2"},
		{"a new re-cut alone goes to a human", Counters{DurationVariants: 1, DurationRecut: 1}, Evidence{DurationRecut: 1}, decisionReview, recut},
		{"a new re-cut beside old negative signals goes to a human", Counters{Undo: 4, DurationRecut: 1}, Evidence{DurationRecut: 1}, decisionReview, recut},
		{"new negative signals with a new re-cut need the LLM", Counters{Undo: 4, DurationRecut: 1}, Evidence{Undo: 4, DurationRecut: 1}, needsLLM, "undo=4"},
		{"new negative signals after an old re-cut need the LLM", Counters{VotesDown: 1, Undo: 2, DurationRecut: 1}, Evidence{VotesDown: 1}, needsLLM, "votes_down=1 undo=2"},
	}
	for _, c := range cases {
		d, r := rules(Signals{Counters: c.c, New: c.new})
		if d != c.decision || r != c.reason {
			t.Errorf("%s: got %s %q, want %s %q", c.name, d, r, c.decision, c.reason)
		}
	}
}

func TestConflictingMarkupWithANegativeRatedAuthorIsIgnored(t *testing.T) {
	entries := []Entry{{CategoryID: 2, Start: 30, End: 70}, {CategoryID: 3, Start: 200, End: 230}}
	for _, c := range []struct {
		name string
		h    humanInterval
		want bool
	}{
		{"same span", humanInterval{2, 30, 70, 0}, false},
		{"IoU 0.5 is agreement", humanInterval{2, 30, 50, 0}, false},
		{"IoU below 0.5", humanInterval{2, 30, 49, 0}, true},
		{"elsewhere", humanInterval{2, 100, 120, 3}, true},
		{"author rated down", humanInterval{2, 100, 120, -1}, false},
		{"same span, other category", humanInterval{3, 30, 70, 0}, true},
		{"self-promotion on its entry", humanInterval{3, 201, 229, 0}, false},
		{"intro", humanInterval{1, 0, 15, 0}, false},
		{"credits", humanInterval{4, 580, 600, 0}, false},
	} {
		if got := conflicts(c.h, entries, testCategories); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
