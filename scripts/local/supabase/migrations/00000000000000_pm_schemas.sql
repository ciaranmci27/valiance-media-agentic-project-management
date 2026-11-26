-- Local test stack only. PostgREST is told to serve pm and pm_custom
-- (config.jsonc) and fails its health check while they do not exist, so the
-- two empty schemas are made when the stack first starts. npm run local:up
-- then loads ../../../supabase/schema.sql into them, as a fresh install does
-- (its CREATE SCHEMA IF NOT EXISTS lines leave these as they are).
CREATE SCHEMA IF NOT EXISTS pm;
CREATE SCHEMA IF NOT EXISTS pm_custom;
ALTER SCHEMA pm OWNER TO postgres;
ALTER SCHEMA pm_custom OWNER TO postgres;
