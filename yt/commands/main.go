package main

import (
	"os"

	"odedohbest/video-calculate/calculator"
)

func main() {
	args := os.Args[1:]
	if len(args) > 0 {
		calculator.Run("yt_", args[0])
	} else {
		calculator.Run("yt_")
	}
}
