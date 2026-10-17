-- Additive operator migration. Existing function ownership and grants are preserved.
CREATE OR REPLACE FUNCTION taste_runtime.session_create(p_hash bytea, p_envelope jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET statement_timeout = '3s' SET lock_timeout = '1s' AS $function$
DECLARE at_time timestamptz; expiry timestamptz; stored jsonb;
BEGIN
  IF octet_length(p_hash) <> 32 OR p_hash IS NULL OR (p_envelope->'version' IS DISTINCT FROM '1'::jsonb AND p_envelope->'version' IS DISTINCT FROM '2'::jsonb) OR
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

CREATE OR REPLACE FUNCTION taste_runtime.session_commit(p_hash bytea, p_fence text, p_revision bigint, p_envelope jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET statement_timeout = '3s' SET lock_timeout = '1s' AS $function$
DECLARE item taste_runtime.sessions; at_time timestamptz; stored jsonb;
BEGIN
  SELECT * INTO item FROM taste_runtime.sessions WHERE id = p_hash FOR UPDATE;
  at_time := clock_timestamp();
  IF NOT FOUND OR item.expires_at <= at_time OR item.lease_until <= at_time OR item.lease_until IS NULL OR
    item.canceled OR p_fence IS NULL OR item.operation_fence IS DISTINCT FROM p_fence OR item.revision IS DISTINCT FROM p_revision OR
    p_envelope#>>'{state,operationFence}' IS DISTINCT FROM p_fence OR (p_envelope->'version' IS DISTINCT FROM '1'::jsonb AND p_envelope->'version' IS DISTINCT FROM '2'::jsonb) THEN RETURN false; END IF;
  stored := taste_runtime.session_envelope(p_envelope, item.revision + 1, at_time + interval '1800 seconds', NULL);
  IF stored#>'{state,result}' <> 'null'::jsonb THEN
    stored := jsonb_set(stored, '{state,result,revision}', to_jsonb(item.revision + 1));
  END IF;
  UPDATE taste_runtime.sessions SET revision = item.revision + 1, envelope = stored, operation_fence = NULL, lease_until = NULL,
    canceled = false, expires_at = at_time + interval '1800 seconds', updated_at = at_time WHERE id = p_hash;
  RETURN true;
END
$function$;
