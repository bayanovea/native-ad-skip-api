package detector

import "testing"

func TestNewAPIClientReadsEnvKey(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", " ")
	if _, err := newAPIClient(); err == nil {
		t.Fatal("blank ANTHROPIC_API_KEY: want an error")
	}
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-test")
	if _, err := newAPIClient(); err != nil {
		t.Fatalf("key present: %v", err)
	}
}
