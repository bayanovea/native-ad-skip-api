TEST_DB     ?= skipper_tests
DB_HOST_LOCAL ?= localhost

test-calculator:
	TEST_DB_NAME=$(TEST_DB) DB_NAME=$(TEST_DB) DB_HOST=$(DB_HOST_LOCAL) go test ./calculator -run TestIntegration -v

test-e2e:
	docker-compose -f docker-compose.e2e.yml up --build --abort-on-container-exit

pull-dump:
	bash scripts/pull-prod-dump.sh

.PHONY: test-calculator test-e2e pull-dump
