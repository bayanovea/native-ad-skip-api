package main_test

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"testing"

	"github.com/joho/godotenv"
)

func TestСaclulateVideo(t *testing.T) {
	fmt.Println("wwww")

	db := connectDb()
	defer db.Close()

	fmt.Println(db)

	if err := runMigrations(db); err != nil {
		t.Fatalf("Error running migrations: %v", err)
	}

	// Preload test data
	// if err := preloadTestData(db); err != nil {
	// 	t.Fatalf("Error preloading test data: %v", err)
	// }

	// Run integration tests
	// Your integration tests here
}

func runMigrations(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE videos (
			id SERIAL PRIMARY KEY,
			native_id VARCHAR(255)
		);
		
		DO $$ 
		BEGIN 
			CREATE TYPE enum_markup_categories_category AS ENUM ('intro', 'sponsor', 'self_promotion', 'credits'); 
		EXCEPTION 
			WHEN duplicate_object THEN null; 
		END $$;
		
		CREATE TABLE IF NOT EXISTS markup_categories (
			id SERIAL PRIMARY KEY,
			category enum_markup_categories_category NOT NULL
		);

		CREATE TABLE IF NOT EXISTS markups (
			id SERIAL PRIMARY KEY,
			video_id INTEGER,
			user_id UUID,
			category_id INTEGER,
			is_new BOOLEAN DEFAULT TRUE,
			FOREIGN KEY (video_id) REFERENCES video(id),
			FOREIGN KEY (category_id) REFERENCES markup_category(id)
		);
		
		CREATE TABLE IF NOT EXISTS markup_time_intervals (
			id SERIAL PRIMARY KEY,
			markup_id INTEGER,
			start FLOAT,
			"end" FLOAT,
			FOREIGN KEY (markup_id) REFERENCES markup(id)
		);
		
		CREATE TABLE IF NOT EXISTS video_calculateds (
			id SERIAL PRIMARY KEY,
			video_id INTEGER,
			data JSON,
			meta JSON,
			FOREIGN KEY (video_id) REFERENCES video(id)
		);
	`)
	if err != nil {
		return err
	}

	return nil
}

func connectDb() *sql.DB {
	if err := godotenv.Load("../.env_tests"); err != nil {
		log.Fatalf("Can not load .env файл: %v", err)
	}

	psqlInfo := fmt.Sprintf("host=%s port=%d user=%s "+
		"password=%s dbname=%s sslmode=disable",
		os.Getenv("DB_HOST"), 5432, os.Getenv("DB_USER"), os.Getenv("DB_PASSWORD"), os.Getenv("DB_NAME"))

	fmt.Println(psqlInfo)

	db, err := sql.Open("postgres", psqlInfo)
	if err != nil {
		panic(err)
	}

	err = db.Ping()
	if err != nil {
		panic(err)
	}

	return db
}
