package main

import (
	"os"

	"odedohbest/video-calculate/calculator"
)

func main() {
	args := os.Args[1:]
	if len(args) > 0 {
		calculator.Run("", args[0])
	} else {
		calculator.Run("")
	}
}
