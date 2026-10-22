package main

import (
	"fmt"
	"log"
	"os"

	"github.com/joho/godotenv"

	"odedohbest/video-calculate/ai/judge"
	"odedohbest/video-calculate/ai/pipeline"
)

const usage = "usage: ai detect [native_id] | ai judge"

func main() {
	godotenv.Load("/app/.env") // cron's only source of env; variables already set win
	args := os.Args[1:]
	switch {
	case len(args) >= 1 && len(args) <= 2 && args[0] == "detect":
		cfg, err := pipeline.ConfigFromEnv()
		if err != nil {
			log.Fatalf("ai detect: %v", err)
		}
		nativeID := ""
		if len(args) == 2 {
			nativeID = args[1]
		}
		if err := pipeline.Detect(cfg, nativeID); err != nil {
			log.Fatalf("ai detect: %v", err)
		}
	case len(args) == 1 && args[0] == "judge":
		if err := judge.Run(judge.ConfigFromEnv()); err != nil {
			log.Fatalf("ai judge: %v", err)
		}
	default:
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
}
