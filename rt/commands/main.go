package main

import (
	"log"
	"os"

	"odedohbest/video-calculate/calculator"
)

func main() {
	args := os.Args[1:]
	var err error
	if len(args) > 0 {
		err = calculator.Run("rt_", args[0])
	} else {
		err = calculator.Run("rt_")
	}
	if err != nil {
		log.Fatalf("Calculate failed: %v", err)
	}
}
