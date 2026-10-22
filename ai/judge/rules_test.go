package judge

import "testing"

func TestRules(t *testing.T) {
	cases := []struct {
		name     string
		c        Counters
		decision string
		reason   string
	}{
		{"no signals", Counters{}, decisionOK, "no negative signal"},
		{"likes, clicks and agreeing markups are not negative", Counters{VotesUp: 5, Clicks: 9, HumanMarkups: 2}, decisionOK, "no negative signal"},
		{"old split rows alone are not a re-cut", Counters{DurationVariants: 3}, decisionOK, "no negative signal"},
		{"dislikes", Counters{VotesDown: 2}, needsLLM, "votes_down=2"},
		{"undo", Counters{Undo: 1}, needsLLM, "undo=1"},
		{"conflicting markup", Counters{HumanMarkups: 1, ConflictingMarkups: 1}, needsLLM, "conflicting_markups=1"},
		{"several", Counters{VotesDown: 1, Undo: 3}, needsLLM, "votes_down=1 undo=3"},
		{"a re-cut wins over everything", Counters{Undo: 4, DurationVariants: 1, DurationRecut: 1}, decisionWithdraw,
			"duration: 1 videos rows of another cut requested after publish"},
	}
	for _, c := range cases {
		d, r := rules(Signals{Counters: c.c})
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

func TestMoved(t *testing.T) {
	c := Counters{VotesUp: 1, Undo: 2, DurationVariants: 1}
	for _, x := range []struct {
		stored string
		want   bool
	}{
		{``, true},
		{`not json`, true},
		{`{"votes_up":1,"undo":2,"duration_variants":1}`, false},
		{`{"votes_up":1,"votes_down":0,"undo":2,"clicks":0,"human_markups":0,"conflicting_markups":0,"duration_variants":1,"duration_recut":0}`, false},
		{`{"votes_up":1,"undo":1,"duration_variants":1}`, true},
	} {
		if got := moved([]byte(x.stored), c); got != x.want {
			t.Errorf("moved(%s) = %v, want %v", x.stored, got, x.want)
		}
	}
}
