package main

import (
	"fmt"
	"log"
	"os"

	"github.com/joho/godotenv"

	"odedohbest/video-calculate/ai/pipeline"
)

const usage = "usage: ai detect [native_id]"

func main() {
	godotenv.Load("/app/.env") // cron's only source of env; variables already set win
	args := os.Args[1:]
	if len(args) == 0 || args[0] != "detect" || len(args) > 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
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
}
