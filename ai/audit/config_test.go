package audit

import (
	"strings"
	"testing"
)

func TestConfigDefaults(t *testing.T) {
	for _, k := range []string{"AI_AUDIT_ENABLED", "AI_AUDIT_TELEGRAM", "AI_AUDIT_MODEL", "AI_AUDIT_PROMPT", "AI_CLIENT", "TELEGRAM_API_URL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"} {
		t.Setenv(k, "")
	}
	c := ConfigFromEnv()
	if c.Enabled || c.Telegram || c.Model != "claude-sonnet-5-5" || c.PromptPath != "/app/ai/prompts/audit-v1.md" || c.Client != "anthropic" || c.TelegramURL != "https://api.telegram.org" {
		t.Fatalf("defaults = %+v", c)
	}
	t.Setenv("AI_AUDIT_ENABLED", "yes")
	if ConfigFromEnv().Enabled {
		t.Fatal("only on switches it on")
	}
}

func TestConfigCheck(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	err := Config{Client: "anthropic", Telegram: true}.check()
	for _, name := range []string{"ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"} {
		if err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("check() = %v, want %s named", err, name)
		}
	}
	if err := (Config{Client: "fixture", Telegram: true, BotToken: "t", ChatID: "c"}).check(); err != nil {
		t.Fatalf("fixture needs no key: %v", err)
	}
	if err := (Config{Client: "fixture"}).check(); err != nil {
		t.Fatalf("the ping off needs no Telegram variables: %v", err)
	}
	if err := (Config{Client: "batch", BotToken: "t", ChatID: "c"}).check(); err == nil {
		t.Fatal("unknown client passed")
	}
}
