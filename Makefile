TEST_DB     ?= skipper_tests
DB_HOST_LOCAL ?= localhost

test-calculator:
	TEST_DB_NAME=$(TEST_DB) DB_NAME=$(TEST_DB) DB_HOST=$(DB_HOST_LOCAL) go test ./calculator -run TestIntegration -v

test-e2e:
	docker-compose -f docker-compose.e2e.yml up --build --abort-on-container-exit --exit-code-from e2e-app

test-unit:
	node --test test/review-sheet.test.js test/find-video-for-read.test.js test/prometheus-wrapper.test.js test/redact-request.test.js

pull-dump:
	bash scripts/pull-prod-dump.sh

.PHONY: test-calculator test-e2e test-unit pull-dump
