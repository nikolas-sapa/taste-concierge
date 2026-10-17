-- Additive operator migration. Runtime never executes this file.
CREATE SCHEMA IF NOT EXISTS taste_runtime;
REVOKE ALL ON SCHEMA taste_runtime FROM PUBLIC;
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'taste_runtime_app') THEN
    CREATE ROLE taste_runtime_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$role$;
GRANT USAGE ON SCHEMA taste_runtime TO taste_runtime_app;
DO $temporary_ddl$
BEGIN
  EXECUTE pg_catalog.format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', pg_catalog.current_database());
END
$temporary_ddl$;
ALTER DEFAULT PRIVILEGES IN SCHEMA taste_runtime REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE IF NOT EXISTS taste_runtime.migrations (
  id varchar(80) PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS taste_runtime.session_guard (
  id integer PRIMARY KEY CHECK (id = 1), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO taste_runtime.session_guard (id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS taste_runtime.sessions (
  id bytea PRIMARY KEY CHECK (octet_length(id) = 32), revision bigint NOT NULL CHECK (revision >= 0),
  envelope jsonb NOT NULL CHECK (octet_length(envelope::text) <= 262144),
  expires_at timestamptz NOT NULL, operation_fence varchar(64), lease_until timestamptz,
  canceled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((operation_fence IS NULL AND lease_until IS NULL) OR
    (operation_fence ~ '^[a-f0-9]{64}$' AND lease_until IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON taste_runtime.sessions (expires_at);
CREATE TABLE IF NOT EXISTS taste_runtime.session_creations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS session_creations_created_idx ON taste_runtime.session_creations (created_at);
REVOKE ALL ON ALL TABLES IN SCHEMA taste_runtime FROM PUBLIC, taste_runtime_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA taste_runtime FROM PUBLIC, taste_runtime_app;

CREATE OR REPLACE FUNCTION taste_runtime.session_envelope(p_envelope jsonb, p_revision bigint, p_expiry timestamptz, p_fence text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $function$
  SELECT jsonb_set(jsonb_set(jsonb_set(p_envelope, '{state,revision}', to_jsonb(p_revision)),
    '{state,expiresAt}', to_jsonb(floor(extract(epoch FROM p_expiry) * 1000)::bigint)),
    '{state,operationFence}', coalesce(to_jsonb(p_fence), 'null'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION taste_runtime.session_create(p_hash bytea, p_envelope jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET statement_timeout = '3s' SET lock_timeout = '1s' AS $function$
DECLARE at_time timestamptz; expiry timestamptz; stored jsonb;
BEGIN
  IF octet_length(p_hash) <> 32 OR p_hash IS NULL OR p_envelope->'version' IS DISTINCT FROM '1'::jsonb OR
    p_envelope#>'{state,revision}' IS DISTINCT FROM '0'::jsonb OR p_envelope#>'{state,brief}' IS DISTINCT FROM 'null'::jsonb OR
    p_envelope#>'{state,result}' IS DISTINCT FROM 'null'::jsonb OR p_envelope#>'{state,operationFence}' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'Invalid session input';
  END IF;
  PERFORM id FROM taste_runtime.session_guard WHERE id = 1 FOR UPDATE;
  at_time := clock_timestamp(); expiry := at_time + interval '1800 seconds';
  DELETE FROM taste_runtime.sessions WHERE expires_at <= at_time;
  DELETE FROM taste_runtime.session_creations WHERE created_at <= at_time - interval '60 seconds';
  IF (SELECT count(*) FROM taste_runtime.sessions) >= 200 OR (SELECT count(*) FROM taste_runtime.session_creations) >= 20 THEN
    RETURN jsonb_build_object('status', 'capacity');
  END IF;
  stored := taste_runtime.session_envelope(p_envelope, 0, expiry, NULL);
  INSERT INTO taste_runtime.sessions (id, revision, envelope, expires_at) VALUES (p_hash, 0, stored, expiry);
  INSERT INTO taste_runtime.session_creations DEFAULT VALUES;
  RETURN jsonb_build_object('status', 'created', 'envelope', stored);
END
$function$;

CREATE OR REPLACE FUNCTION taste_runtime.session_get(p_hash bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET statement_timeout = '3s' SET lock_timeout = '1s' AS $function$
DECLARE item taste_runtime.sessions; at_time timestamptz; stored jsonb;
BEGIN
  SELECT * INTO item FROM taste_runtime.sessions WHERE id = p_hash FOR UPDATE;
  at_time := clock_timestamp();
  IF NOT FOUND OR item.expires_at <= at_time THEN RETURN jsonb_build_object('status', 'missing'); END IF;
  stored := taste_runtime.session_envelope(item.envelope, item.revision, at_time + interval '1800 seconds', item.operation_fence);
  UPDATE taste_runtime.sessions SET expires_at = at_time + interval '1800 seconds', envelope = stored, updated_at = at_time WHERE id = p_hash;
  RETURN jsonb_build_object('status', 'found', 'envelope', stored);
END
$function$;

CREATE OR REPLACE FUNCTION taste_runtime.session_begin(p_hash bytea, p_revision bigint, p_mode text, p_fence text, p_lease_ms integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET statement_timeout = '3s' SET lock_timeout = '1s' AS $function$
DECLARE item taste_runtime.sessions; at_time timestamptz; stored jsonb;
BEGIN
  IF p_fence IS NULL OR p_fence !~ '^[a-f0-9]{64}$' OR p_mode IS NULL OR p_mode NOT IN ('initialize','update','select') OR
    p_lease_ms IS NULL OR p_lease_ms < 1 OR p_lease_ms > 90000 THEN
    RAISE EXCEPTION 'Invalid operation input';
  END IF;
  SELECT * INTO item FROM taste_runtime.sessions WHERE id = p_hash FOR UPDATE;
  at_time := clock_timestamp();
  IF NOT FOUND OR item.expires_at <= at_time THEN RETURN jsonb_build_object('status', 'missing'); END IF;
  IF item.operation_fence IS NOT NULL AND item.lease_until > at_time AND NOT item.canceled THEN
    RETURN jsonb_build_object('status', 'busy');
  END IF;
  IF p_revision IS NULL OR p_revision < 0 OR p_revision <> item.revision THEN RETURN jsonb_build_object('status', 'stale'); END IF;
  IF p_mode = 'initialize' AND (item.revision <> 0 OR item.envelope#>'{state,brief}' <> 'null'::jsonb OR
    item.envelope#>'{state,result}' <> 'null'::jsonb) THEN RETURN jsonb_build_object('status', 'invalid-initial'); END IF;
  stored := taste_runtime.session_envelope(item.envelope, item.revision, at_time + interval '1800 seconds', p_fence);
  UPDATE taste_runtime.sessions SET operation_fence = p_fence, lease_until = at_time + p_lease_ms * interval '1 millisecond', canceled = false,
    envelope = stored, expires_at = at_time + interval '1800 seconds', updated_at = at_time WHERE id = p_hash;
  RETURN jsonb_build_object('status', 'admitted', 'fence', p_fence, 'envelope', stored);
END
$function$;

CREATE OR REPLACE FUNCTION taste_runtime.session_commit(p_hash bytea, p_fence text, p_revision bigint, p_envelope jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET statement_timeout = '3s' SET lock_timeout = '1s' AS $function$
DECLARE item taste_runtime.sessions; at_time timestamptz; stored jsonb;
BEGIN
  SELECT * INTO item FROM taste_runtime.sessions WHERE id = p_hash FOR UPDATE;
  at_time := clock_timestamp();
  IF NOT FOUND OR item.expires_at <= at_time OR item.lease_until <= at_time OR item.lease_until IS NULL OR
    item.canceled OR p_fence IS NULL OR item.operation_fence IS DISTINCT FROM p_fence OR item.revision IS DISTINCT FROM p_revision OR
    p_envelope#>>'{state,operationFence}' IS DISTINCT FROM p_fence OR p_envelope->'version' IS DISTINCT FROM '1'::jsonb THEN RETURN false; END IF;
  stored := taste_runtime.session_envelope(p_envelope, item.revision + 1, at_time + interval '1800 seconds', NULL);
  IF stored#>'{state,result}' <> 'null'::jsonb THEN
    stored := jsonb_set(stored, '{state,result,revision}', to_jsonb(item.revision + 1));
  END IF;
  UPDATE taste_runtime.sessions SET revision = item.revision + 1, envelope = stored, operation_fence = NULL, lease_until = NULL,
    canceled = false, expires_at = at_time + interval '1800 seconds', updated_at = at_time WHERE id = p_hash;
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION taste_runtime.session_finish(p_hash bytea, p_fence text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET statement_timeout = '3s' SET lock_timeout = '1s' AS $function$
BEGIN
  UPDATE taste_runtime.sessions SET operation_fence = NULL, lease_until = NULL, canceled = true,
    envelope = taste_runtime.session_envelope(envelope, revision, expires_at, NULL), updated_at = clock_timestamp()
    WHERE id = p_hash AND operation_fence = p_fence;
END
$function$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA taste_runtime FROM PUBLIC;
-- Keep an already installed legacy overload for operators, never for runtime admission.
DO $legacy_begin$
BEGIN
  IF pg_catalog.to_regprocedure('taste_runtime.session_begin(bytea,bigint,text,text)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION taste_runtime.session_begin(bytea,bigint,text,text) FROM taste_runtime_app;
  END IF;
END
$legacy_begin$;
GRANT EXECUTE ON FUNCTION taste_runtime.session_create(bytea,jsonb), taste_runtime.session_get(bytea),
  taste_runtime.session_begin(bytea,bigint,text,text,integer), taste_runtime.session_commit(bytea,text,bigint,jsonb),
  taste_runtime.session_finish(bytea,text) TO taste_runtime_app;
INSERT INTO taste_runtime.migrations (id) VALUES ('001-runtime') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS taste_runtime.body_leases (
  id varchar(64) PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'), expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS body_leases_expiry_idx ON taste_runtime.body_leases (expires_at);
REVOKE ALL ON TABLE taste_runtime.body_leases FROM PUBLIC, taste_runtime_app;
CREATE OR REPLACE FUNCTION taste_runtime.body_acquire(p_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET statement_timeout = '3s' SET lock_timeout = '1s' AS $function$
DECLARE at_time timestamptz;
BEGIN
  IF p_id IS NULL OR p_id !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid body lease'; END IF;
  PERFORM id FROM taste_runtime.session_guard WHERE id = 1 FOR UPDATE;
  at_time := clock_timestamp();
  DELETE FROM taste_runtime.body_leases WHERE expires_at <= at_time;
  IF (SELECT count(*) FROM taste_runtime.body_leases) >= 20 THEN RETURN false; END IF;
  INSERT INTO taste_runtime.body_leases (id, expires_at) VALUES (p_id, at_time + interval '6 seconds');
  RETURN true;
END
$function$;
CREATE OR REPLACE FUNCTION taste_runtime.body_release(p_id text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog SET statement_timeout = '3s' SET lock_timeout = '1s' AS $function$
  DELETE FROM taste_runtime.body_leases WHERE id = p_id;
$function$;
REVOKE ALL ON FUNCTION taste_runtime.body_acquire(text), taste_runtime.body_release(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION taste_runtime.body_acquire(text), taste_runtime.body_release(text) TO taste_runtime_app;
CREATE OR REPLACE FUNCTION taste_runtime.health()
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog SET statement_timeout = '3s' SET lock_timeout = '1s' AS $function$
  SELECT EXISTS (SELECT 1 FROM taste_runtime.migrations WHERE id = '001-runtime') AND
    EXISTS (SELECT 1 FROM taste_runtime.session_guard WHERE id = 1) AND
    to_regclass('taste_runtime.sessions') IS NOT NULL AND to_regclass('taste_runtime.body_leases') IS NOT NULL;
$function$;
REVOKE ALL ON FUNCTION taste_runtime.health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION taste_runtime.health() TO taste_runtime_app;
