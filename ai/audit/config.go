// Package audit is `ai audit`: it checks finished assessor review batches with
// fixed rules and one model call over the comments, records every audit in
// prv_review_audits and pings the owner in Telegram with the new findings. It
// only reads the review and AI tables.
package audit

import (
	"errors"
	"fmt"
	"os"
	"strings"
)

// Config is the audit's environment. The switch defaults off.
type Config struct {
	Enabled     bool   // AI_AUDIT_ENABLED=on
	Telegram    bool   // AI_AUDIT_TELEGRAM=on: ping the owner; off = the page block only
	Model       string // AI_AUDIT_MODEL
	PromptPath  string // AI_AUDIT_PROMPT
	Client      string // AI_CLIENT: anthropic | messages (both the Messages API here) | fixture
	FixtureDir  string // AI_FIXTURE_DIR: <batch>.audit.json for AI_CLIENT=fixture
	BotToken    string // TELEGRAM_BOT_TOKEN
	ChatID      string // TELEGRAM_CHAT_ID
	TelegramURL string // TELEGRAM_API_URL, overridable for tests
}

func ConfigFromEnv() Config {
	return Config{
		Enabled:     os.Getenv("AI_AUDIT_ENABLED") == "on",
		Telegram:    os.Getenv("AI_AUDIT_TELEGRAM") == "on",
		Model:       env("AI_AUDIT_MODEL", "claude-sonnet-5-5"),
		PromptPath:  env("AI_AUDIT_PROMPT", "/app/ai/prompts/audit-v1.md"),
		Client:      env("AI_CLIENT", "anthropic"),
		FixtureDir:  env("AI_FIXTURE_DIR", "/app/test/fixtures/ai"),
		BotToken:    strings.TrimSpace(os.Getenv("TELEGRAM_BOT_TOKEN")),
		ChatID:      strings.TrimSpace(os.Getenv("TELEGRAM_CHAT_ID")),
		TelegramURL: strings.TrimRight(env("TELEGRAM_API_URL", "https://api.telegram.org"), "/"),
	}
}

// check names what a run that audits needs and is missing; a switched-off tick needs nothing.
func (c Config) check() error {
	var missing []string
	if c.Client != "fixture" && strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY")) == "" {
		missing = append(missing, "ANTHROPIC_API_KEY")
	}
	if c.Telegram && c.BotToken == "" {
		missing = append(missing, "TELEGRAM_BOT_TOKEN")
	}
	if c.Telegram && c.ChatID == "" {
		missing = append(missing, "TELEGRAM_CHAT_ID")
	}
	if len(missing) > 0 {
		return fmt.Errorf("%s not set", strings.Join(missing, ", "))
	}
	switch c.Client {
	case "anthropic", "messages", "fixture":
		return nil
	}
	return errors.New("AI_CLIENT must be anthropic, messages or fixture, got " + c.Client)
}

func env(name, def string) string {
	if s := os.Getenv(name); s != "" {
		return s
	}
	return def
}
