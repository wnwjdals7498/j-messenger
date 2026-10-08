#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
\getenv db_password JMS_DB_PASSWORD
CREATE ROLE jgw_messenger LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 30;
SELECT format('ALTER ROLE jgw_messenger PASSWORD %L', :'db_password') \gexec
ALTER ROLE jgw_messenger SET statement_timeout = '10s';
ALTER ROLE jgw_messenger SET timezone = 'UTC';
CREATE DATABASE jgw_messenger OWNER jgw_messenger;
REVOKE CONNECT, TEMPORARY ON DATABASE postgres, template1, jgw_messenger FROM PUBLIC;
GRANT CONNECT ON DATABASE jgw_messenger TO jgw_messenger;
SQL
