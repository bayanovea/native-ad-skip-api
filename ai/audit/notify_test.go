package audit

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMessage(t *testing.T) {
	fs := []Finding{
		{Kind: "precision", Severity: severityOwner, Items: []string{"S3"}, Text: "не реклама", New: true},
		{Kind: "agreement", Severity: severityOwner, Items: []string{"S1"}, Text: "старое", New: false},
		{Kind: "bounds", Severity: severityInfo, Text: "границы", New: true},
		{Kind: "judge_false_alarm", Severity: severityBacklog, Items: []string{"A1", "A2"}, Text: "ложная тревога", New: true},
	}
	m := message("ai-served-p1", "Итог.", fs)
	for _, want := range []string{"ai-served-p1", "Итог.", "[нужен ты] S3: не реклама", "[в бэклог] A1, A2: ложная тревога", "/admin/review?reviewer=bayanovea"} {
		if !strings.Contains(m, want) {
			t.Errorf("message lacks %q:\n%s", want, m)
		}
	}
	for _, not := range []string{"старое", "границы", "http"} {
		if strings.Contains(m, not) {
			t.Errorf("message has %q", not)
		}
	}
	if !anyPings(fs) || anyPings(fs[1:3]) {
		t.Fatal("anyPings")
	}
	long := message("b", strings.Repeat("я", 5000), nil)
	if n := len([]rune(long)); n > messageMax+1 {
		t.Fatalf("message of %d runes", n)
	}
}

func TestTelegramSend(t *testing.T) {
	var got map[string]any
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/botTOKEN/sendMessage" {
			t.Errorf("path %s", r.URL.Path)
		}
		json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(status)
		if status == http.StatusOK {
			w.Write([]byte(`{"ok":true}`))
		} else {
			w.Write([]byte(`{"ok":false,"description":"Bad Request: chat not found"}`))
		}
	}))
	defer srv.Close()
	tg := newTelegram(Config{TelegramURL: srv.URL, BotToken: "TOKEN", ChatID: "-100"})
	if err := tg.send("привет"); err != nil {
		t.Fatal(err)
	}
	if got["chat_id"] != "-100" || got["text"] != "привет" || got["parse_mode"] != nil {
		t.Fatalf("body = %v", got)
	}
	status = http.StatusBadRequest
	if err := tg.send("x"); err == nil || !strings.Contains(err.Error(), "chat not found") {
		t.Fatalf("err = %v", err)
	}
	down := newTelegram(Config{TelegramURL: "http://127.0.0.1:1", BotToken: "SECRET", ChatID: "1"})
	if err := down.send("x"); err == nil || strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("err = %v", err)
	}
}
