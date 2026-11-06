#!/bin/sh
# Creates the runtime role the application uses. Not a superuser, not the table owner, cannot bypass row-level security. Its password comes from
# the environment (APP_DB_PASSWORD), never from this file. Runs once, when the database is first created.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v app_pw="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE loopsignal_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
SQL
