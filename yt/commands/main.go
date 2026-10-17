package main

import (
	"log"
	"os"

	"odedohbest/video-calculate/calculator"
)

func main() {
	args := os.Args[1:]
	var err error
	switch {
	case len(args) > 0 && args[0] == "--recompute-ratings":
		err = calculator.RecomputeRatings("yt_")
	case len(args) > 0:
		err = calculator.Run("yt_", args[0])
	default:
		err = calculator.Run("yt_")
	}
	if err != nil {
		log.Fatalf("Calculate failed: %v", err)
	}
}
