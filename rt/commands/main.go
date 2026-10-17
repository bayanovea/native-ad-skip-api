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
		err = calculator.RecomputeRatings("rt_")
	case len(args) > 0:
		err = calculator.Run("rt_", args[0])
	default:
		err = calculator.Run("rt_")
	}
	if err != nil {
		log.Fatalf("Calculate failed: %v", err)
	}
}
