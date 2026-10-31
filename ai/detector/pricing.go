package detector

// Price is USD per million tokens. Cache write is the 5-minute price
// (1.25x input); the eval never uses the 1-hour tier.
type Price struct {
	Input, Output, CacheRead, CacheWrite float64
}

// Prices as published on 2026-10-11 (platform.claude.com/pricing). Recorded
// into every run's config.json so a cost number stays reproducible after the
// price list changes. Unknown model -> zero price and a warning from the CLI.
var Prices = map[string]Price{
	"claude-opus-5-5":   {Input: 4, Output: 20, CacheRead: 0.20, CacheWrite: 5},
	"claude-sonnet-5-5": {Input: 2, Output: 10, CacheRead: 0.20, CacheWrite: 2.5},
	"claude-haiku-4-5":  {Input: 1, Output: 5, CacheRead: 0.10, CacheWrite: 1.25},
	// OpenAI, as published on 2026-10-30 (developers.openai.com/api/docs/pricing): cache
	// reads are automatic and writes free; reasoning tokens bill as output.
	"gpt-5":         {Input: 1.25, Output: 10, CacheRead: 0.125},
	"gpt-5-mini":    {Input: 0.25, Output: 2, CacheRead: 0.025},
	"gpt-5.6-luna":  {Input: 0.20, Output: 1.20, CacheRead: 0.02},
	"gpt-6-luna":    {Input: 0.10, Output: 0.50, CacheRead: 0.01}, // x2 input, x1.5 output above 272K input tokens: not modelled
	"gpt-6.1-terra": {Input: 1, Output: 5, CacheRead: 0.05},
	"gpt-6.1-sol":   {Input: 2, Output: 10, CacheRead: 0.10},
}

// Cost of one call in USD.
func (p Price) Cost(u Usage) float64 {
	const m = 1e6
	return float64(u.InputTokens)*p.Input/m + float64(u.OutputTokens)*p.Output/m +
		float64(u.CacheReadTokens)*p.CacheRead/m + float64(u.CacheWriteTokens)*p.CacheWrite/m
}
