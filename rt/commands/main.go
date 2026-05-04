package main

import (
	"os"

	"odedohbest/video-calculate/calculator"
)

func main() {
	args := os.Args[1:]
	if len(args) > 0 {
		calculator.Run("rt_", args[0])
	} else {
		calculator.Run("rt_")
	}
}
