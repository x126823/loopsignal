-- Runtime role used by the application. Not a superuser, not the table owner, no BYPASSRLS,
-- so Row Level Security always applies to it. Migrations run as the owner (DATABASE_URL).
-- Dev-only password; real environments provision this role out of band.
CREATE ROLE loopsignal_app LOGIN PASSWORD 'loopsignal_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
