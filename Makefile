TEST_DB     ?= skipper_tests
DB_HOST_LOCAL ?= localhost
DUMP_DIR    ?= $(HOME)/dumps

test-calculator:
	TEST_DB_NAME=$(TEST_DB) DB_NAME=$(TEST_DB) DB_HOST=$(DB_HOST_LOCAL) go test ./calculator -run TestIntegration -v

test-e2e:
	docker-compose -f docker-compose.e2e.yml up --build --abort-on-container-exit

dump:
	mkdir -p $(DUMP_DIR)
	set -a; . ./.env_local; set +a; \
	PGPASSWORD=$$DB_PASSWORD pg_dump -h $$DB_HOST -U $$DB_USER -F c -f $(DUMP_DIR)/$${DB_NAME}_$$(date +%Y%m%d_%H%M%S).dump $$DB_NAME

psql-connect:
	psql -h localhost -U postgres -d adskip

.PHONY: test-calculator test-e2e dump psql-connect
