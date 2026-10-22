package pipeline

import (
	"database/sql"
	"math"

	"odedohbest/video-calculate/ai/vtt"
)

// maxOverrun is the timeline gate: a track whose last cue ends more than this many
// seconds after the video does not fit it (eval audit: catches 13 of 15 drifted videos).
const maxOverrun = 3.0

// durationTolerance is lib/duration-tolerance.js DURATION_TOLERANCE.
const durationTolerance = 2

func overrun(cues []vtt.Cue, duration float64) float64 {
	if len(cues) == 0 {
		return 0
	}
	return cues[len(cues)-1].End - duration
}

func timelineOK(overrunS float64) bool { return overrunS <= maxOverrun }

// findOrCreateVideo is prv/repository/video.js findByNativeIdAndDuration: the closest
// row within the tolerance, else the row without a duration (which gets this one),
// else a new row. The AI row is keyed by it, so a client whose player reports
// another cut lands elsewhere and never gets these segments.
func findOrCreateVideo(db *sql.DB, nativeID string, duration int) (int, error) {
	var id int
	err := db.QueryRow(`SELECT id FROM videos WHERE native_id = $1 AND duration BETWEEN $2::int - $3::int AND $2::int + $3::int
		ORDER BY ABS(duration - $2::int), id LIMIT 1`, nativeID, duration, durationTolerance).Scan(&id)
	if err != sql.ErrNoRows {
		return id, err
	}
	err = db.QueryRow(`UPDATE videos SET duration = $2, "updatedAt" = NOW()
		WHERE id = (SELECT id FROM videos WHERE native_id = $1 AND duration IS NULL ORDER BY id LIMIT 1) RETURNING id`,
		nativeID, duration).Scan(&id)
	if err != sql.ErrNoRows {
		return id, err
	}
	err = db.QueryRow(`INSERT INTO videos (native_id, duration, "createdAt", "updatedAt") VALUES ($1, $2, NOW(), NOW()) RETURNING id`,
		nativeID, duration).Scan(&id)
	return id, err
}

// durationVariants counts the native_id's other videos rows whose duration differs
// from yt-dlp's by more than the tolerance: a judge signal, not a gate, because old
// split families exist (docs/backlog/video-rows-race-and-old-split-families.md).
func durationVariants(db *sql.DB, nativeID string, duration float64) (int, error) {
	var n int
	err := db.QueryRow(`SELECT COUNT(*) FROM videos WHERE native_id = $1 AND ABS(duration - $2::float8) > $3`,
		nativeID, duration, durationTolerance).Scan(&n)
	return n, err
}

func roundDuration(d float64) int { return int(math.Round(d)) }
