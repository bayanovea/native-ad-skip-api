package audit

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// messageMax stays under Telegram's 4096-character limit.
const messageMax = 4000

var severityLabel = map[string]string{severityOwner: "нужен ты", severityBacklog: "в бэклог"}

// telegram posts plain text (no parse_mode: comment text cannot inject markup) to the alerting chat.
type telegram struct {
	url, token, chat string
	client           *http.Client
}

func newTelegram(cfg Config) *telegram {
	return &telegram{url: cfg.TelegramURL, token: cfg.BotToken, chat: cfg.ChatID, client: &http.Client{Timeout: 15 * time.Second}}
}

func (t *telegram) send(text string) error {
	body, err := json.Marshal(map[string]any{"chat_id": t.chat, "text": text, "disable_web_page_preview": true})
	if err != nil {
		return err
	}
	resp, err := t.client.Post(t.url+"/bot"+t.token+"/sendMessage", "application/json", bytes.NewReader(body))
	if err != nil {
		// The URL carries the token; *url.Error prints it, so only the cause is returned.
		return fmt.Errorf("telegram: %s", strings.ReplaceAll(err.Error(), t.token, "…"))
	}
	defer resp.Body.Close()
	var out struct {
		OK          bool   `json:"ok"`
		Description string `json:"description"`
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	_ = json.Unmarshal(b, &out)
	if resp.StatusCode != http.StatusOK || !out.OK {
		return fmt.Errorf("telegram: HTTP %d %s", resp.StatusCode, out.Description)
	}
	return nil
}

// message is the ping for an audit: the batch, the summary and each new owner / backlog finding.
// It names the page by path only: no host, no token.
func message(batch, summary string, findings []Finding) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Аудит батча %s\n", batch)
	if summary != "" {
		b.WriteString(summary + "\n")
	}
	b.WriteString("\n")
	for _, f := range findings {
		if !f.pings() {
			continue
		}
		fmt.Fprintf(&b, "• [%s]", severityLabel[f.Severity])
		if len(f.Items) > 0 {
			b.WriteString(" " + strings.Join(f.Items, ", ") + ":")
		}
		b.WriteString(" " + f.Text + "\n")
	}
	b.WriteString("\n/admin/review?reviewer=" + OwnerReviewer)
	return cut(b.String(), messageMax)
}

func anyPings(findings []Finding) bool {
	for _, f := range findings {
		if f.pings() {
			return true
		}
	}
	return false
}
