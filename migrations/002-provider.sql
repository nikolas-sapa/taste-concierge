CREATE TABLE IF NOT EXISTS taste_runtime.provider_state (
  id integer PRIMARY KEY CHECK (id = 1), policy jsonb, halted boolean NOT NULL DEFAULT false,
  send_id text, send_until timestamptz, last_completed timestamptz,
  allocated_bytes bigint NOT NULL DEFAULT 0 CHECK (allocated_bytes BETWEEN 0 AND 67108864)
);
INSERT INTO taste_runtime.provider_state(id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS taste_runtime.provider_reservations (
  id text PRIMARY KEY, remaining integer NOT NULL CHECK (remaining BETWEEN 0 AND 5), expires_at timestamptz NOT NULL,
  session_hash bytea NOT NULL, session_fence text NOT NULL, session_revision bigint NOT NULL
);
ALTER TABLE taste_runtime.provider_reservations ADD COLUMN IF NOT EXISTS session_hash bytea NOT NULL;
ALTER TABLE taste_runtime.provider_reservations ADD COLUMN IF NOT EXISTS session_fence text NOT NULL;
ALTER TABLE taste_runtime.provider_reservations ADD COLUMN IF NOT EXISTS session_revision bigint NOT NULL;
CREATE TABLE IF NOT EXISTS taste_runtime.provider_attempts (
  id text PRIMARY KEY, reservation text NOT NULL, charged_at timestamptz NOT NULL,
  window_ids jsonb NOT NULL, state text NOT NULL CHECK (state IN ('intent','complete','uncertain')),
  allocated_bytes bigint NOT NULL DEFAULT 2105344, capture_ref text
);
CREATE TABLE IF NOT EXISTS taste_runtime.provider_captures (
  id text PRIMARY KEY, raw bytea NOT NULL CHECK (octet_length(raw) <= 4194304),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'), metadata jsonb NOT NULL,
  kind text NOT NULL CHECK (kind IN ('live','import'))
);
CREATE TABLE IF NOT EXISTS taste_runtime.provider_bindings (
  entity_id text PRIMARY KEY, fixture_id text NOT NULL, evidence_ref text NOT NULL REFERENCES taste_runtime.provider_captures(id)
);

CREATE OR REPLACE FUNCTION taste_runtime.provider_action(action text, ref text, payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, taste_runtime SET lock_timeout = '1s' SET statement_timeout = '3s'
AS $body$
DECLARE
  p taste_runtime.provider_state%ROWTYPE;
  r taste_runtime.provider_reservations%ROWTYPE;
  a taste_runtime.provider_attempts%ROWTYPE;
  db_now timestamptz;
  now_ms numeric;
  windows jsonb;
  policy_window jsonb;
  active_ids jsonb;
  requested integer;
  reserved bigint;
  charged bigint;
  gap numeric;
  bytes bytea;
  stored_bytes bigint;
  rows jsonb;
BEGIN
  IF action NOT IN ('read','reserve','charge','assert','complete','release','halt','capture','bindings')
    OR octet_length(ref) > 500 OR jsonb_typeof(payload) <> 'object' THEN
    RETURN jsonb_build_object('status','configuration');
  END IF;
  SELECT * INTO p FROM taste_runtime.provider_state WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','configuration'); END IF;
  db_now := clock_timestamp();
  IF action = 'bindings' THEN
    IF (SELECT count(*) FROM taste_runtime.provider_bindings) <>
      (SELECT count(*) FROM taste_runtime.provider_bindings b JOIN taste_runtime.provider_captures c ON c.id=b.evidence_ref WHERE c.kind='import') THEN
      RETURN jsonb_build_object('status','configuration');
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('qlooEntityId',b.entity_id,'fixtureId',b.fixture_id,
      'evidenceRef',b.evidence_ref,'envelope',encode(c.raw,'base64'),'digest',c.digest)), '[]'::jsonb)
      INTO rows FROM taste_runtime.provider_bindings b JOIN taste_runtime.provider_captures c ON c.id=b.evidence_ref
      WHERE c.kind='import';
    RETURN jsonb_build_object('status','ok','rows',rows);
  END IF;
  IF action = 'halt' THEN
    UPDATE taste_runtime.provider_state SET halted=true WHERE id=1;
    RETURN jsonb_build_object('status','ok');
  END IF;
  IF action = 'release' THEN
    DELETE FROM taste_runtime.provider_reservations WHERE id=ref;
    RETURN jsonb_build_object('status','ok');
  END IF;
  IF action = 'complete' THEN
    SELECT * INTO a FROM taste_runtime.provider_attempts WHERE id=ref;
    IF NOT FOUND OR p.send_id IS DISTINCT FROM ref THEN RETURN jsonb_build_object('status','configuration'); END IF;
    IF payload->'uncertain' IS DISTINCT FROM 'true'::jsonb AND payload->'uncertain' IS DISTINCT FROM 'false'::jsonb THEN
      RETURN jsonb_build_object('status','configuration');
    END IF;
    IF (payload->>'uncertain')::boolean THEN
      UPDATE taste_runtime.provider_attempts SET state='uncertain' WHERE id=ref;
      UPDATE taste_runtime.provider_state SET halted=true WHERE id=1;
    ELSE
      UPDATE taste_runtime.provider_attempts SET state='complete', allocated_bytes=CASE WHEN capture_ref IS NULL THEN 0 ELSE allocated_bytes END WHERE id=ref;
      UPDATE taste_runtime.provider_state SET send_id=NULL,send_until=NULL,last_completed=db_now,
        allocated_bytes=allocated_bytes-CASE WHEN a.capture_ref IS NULL THEN a.allocated_bytes ELSE 0 END WHERE id=1;
    END IF;
    RETURN jsonb_build_object('status','ok');
  END IF;
  IF action = 'capture' THEN
    SELECT * INTO a FROM taste_runtime.provider_attempts WHERE id=ref;
    IF NOT FOUND OR a.capture_ref IS NOT NULL OR p.send_id IS DISTINCT FROM ref OR
      jsonb_typeof(payload->'metadata') <> 'object' OR octet_length((payload->'metadata')::text)>8192 OR
      (payload->>'privateRef') !~ '^[a-f0-9]{64}\.json$' THEN RETURN jsonb_build_object('status','configuration'); END IF;
    bytes := decode(payload->>'rawBody','base64');
    IF bytes IS NULL OR octet_length(bytes)>2097152 OR encode(sha256(bytes),'hex') IS DISTINCT FROM payload->>'digest' THEN
      RETURN jsonb_build_object('status','configuration');
    END IF;
    stored_bytes := octet_length(bytes)+octet_length((payload->'metadata')::text);
    IF stored_bytes>a.allocated_bytes THEN RETURN jsonb_build_object('status','configuration'); END IF;
    INSERT INTO taste_runtime.provider_captures(id,raw,digest,metadata,kind)
      VALUES(payload->>'privateRef',bytes,payload->>'digest',payload->'metadata','live');
    UPDATE taste_runtime.provider_attempts SET capture_ref=payload->>'privateRef',allocated_bytes=stored_bytes WHERE id=ref;
    UPDATE taste_runtime.provider_state SET allocated_bytes=allocated_bytes-a.allocated_bytes+stored_bytes WHERE id=1;
    RETURN jsonb_build_object('status','ok');
  END IF;
  -- An orphaned send may still be executing upstream. Expiry is never permission to take it over.
  IF p.send_id IS NOT NULL AND p.send_until<=db_now THEN
    UPDATE taste_runtime.provider_state SET halted=true WHERE id=1;
    UPDATE taste_runtime.provider_attempts SET state='uncertain' WHERE id=p.send_id;
    RETURN jsonb_build_object('status','configuration');
  END IF;
  now_ms := extract(epoch FROM db_now)*1000;
  IF p.policy IS NULL OR p.halted OR p.policy->>'version' IS DISTINCT FROM '1' OR p.policy->'verified' IS DISTINCT FROM 'true'::jsonb OR
    p.policy->'priorUsageKnown' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(p.policy->'expiresAt') IS DISTINCT FROM 'number' OR
    jsonb_typeof(p.policy->'windows') IS DISTINCT FROM 'array' OR (p.policy->>'expiresAt')::numeric<=now_ms THEN
    RETURN jsonb_build_object('status','configuration');
  END IF;
  SELECT coalesce(jsonb_agg(w), '[]'::jsonb),coalesce(jsonb_agg(w->'id' ORDER BY w->>'id'),'[]'::jsonb)
    INTO windows,active_ids FROM jsonb_array_elements(p.policy->'windows') w
    WHERE (w->>'startsAt')::numeric<=now_ms AND now_ms<(w->>'endsAt')::numeric;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(windows) w WHERE w->>'kind'='rate') OR
    NOT EXISTS(SELECT 1 FROM jsonb_array_elements(windows) w WHERE w->>'kind'='quota') THEN
    RETURN jsonb_build_object('status','configuration');
  END IF;
  IF action='read' THEN RETURN jsonb_build_object('status','ok','policy',p.policy); END IF;
  IF ref !~ '^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('status','configuration'); END IF;
  IF action='assert' THEN
    SELECT * INTO a FROM taste_runtime.provider_attempts WHERE id=ref;
    SELECT * INTO r FROM taste_runtime.provider_reservations WHERE id=a.reservation AND expires_at>db_now;
    IF NOT FOUND OR a.state<>'intent' OR p.send_id IS DISTINCT FROM ref OR a.window_ids<>active_ids OR
      NOT EXISTS(SELECT 1 FROM taste_runtime.sessions s WHERE s.id=r.session_hash AND s.revision=r.session_revision
        AND s.operation_fence=r.session_fence AND s.lease_until>db_now AND s.expires_at>db_now AND NOT s.canceled) THEN
      RETURN jsonb_build_object('status','configuration');
    END IF;
    RETURN jsonb_build_object('status','ok');
  END IF;
  DELETE FROM taste_runtime.provider_reservations WHERE expires_at<=db_now;
  IF action='reserve' THEN
    requested := (payload->>'count')::integer;
    IF requested IS NULL OR requested<1 OR requested>5 OR (payload->>'tokenHash') !~ '^[a-f0-9]{64}$' OR
      (payload->>'fence') !~ '^[a-f0-9]{64}$' OR jsonb_typeof(payload->'revision') IS DISTINCT FROM 'number' OR
      NOT EXISTS(SELECT 1 FROM taste_runtime.sessions s WHERE s.id=decode(payload->>'tokenHash','hex')
        AND s.revision=(payload->>'revision')::bigint AND s.operation_fence=payload->>'fence'
        AND s.lease_until>db_now AND s.expires_at>db_now AND NOT s.canceled) THEN
      RETURN jsonb_build_object('status','configuration');
    END IF;
    IF (SELECT count(*) FROM taste_runtime.provider_reservations)>=3 THEN RETURN jsonb_build_object('status','limited'); END IF;
  ELSE
    SELECT * INTO r FROM taste_runtime.provider_reservations WHERE id=payload->>'reservation';
    IF NOT FOUND OR r.remaining<1 OR EXISTS(SELECT 1 FROM taste_runtime.provider_attempts WHERE id=ref) OR
      NOT EXISTS(SELECT 1 FROM taste_runtime.sessions s WHERE s.id=r.session_hash AND s.revision=r.session_revision
        AND s.operation_fence=r.session_fence AND s.lease_until>db_now AND s.expires_at>db_now AND NOT s.canceled) THEN
      RETURN jsonb_build_object('status','configuration');
    END IF;
    requested := r.remaining;
  END IF;
  SELECT coalesce(sum(remaining),0) INTO reserved FROM taste_runtime.provider_reservations
    WHERE action='reserve' OR id<>r.id;
  FOR policy_window IN SELECT * FROM jsonb_array_elements(windows) LOOP
    SELECT count(*) INTO charged FROM taste_runtime.provider_attempts WHERE window_ids ? (policy_window->>'id');
    IF (policy_window->>'usedBeforeLedger')::bigint+charged+reserved+requested>(policy_window->>'ceiling')::bigint THEN
      RETURN jsonb_build_object('status','limited');
    END IF;
  END LOOP;
  IF action='reserve' THEN
    INSERT INTO taste_runtime.provider_reservations(id,remaining,expires_at,session_hash,session_fence,session_revision)
      VALUES(ref,requested,db_now+interval '45 seconds',decode(payload->>'tokenHash','hex'),payload->>'fence',(payload->>'revision')::bigint);
    RETURN jsonb_build_object('status','ok');
  END IF;
  IF p.send_id IS NOT NULL THEN RETURN jsonb_build_object('status','wait','waitMs',100); END IF;
  gap := greatest(5000,(p.policy->>'minIntervalMs')::numeric)-extract(epoch FROM (db_now-p.last_completed))*1000;
  IF gap>0 THEN RETURN jsonb_build_object('status','wait','waitMs',ceil(gap)); END IF;
  IF p.allocated_bytes+2105344>67108864 THEN RETURN jsonb_build_object('status','limited'); END IF;
  INSERT INTO taste_runtime.provider_attempts(id,reservation,charged_at,window_ids,state) VALUES(ref,r.id,db_now,active_ids,'intent');
  UPDATE taste_runtime.provider_reservations SET remaining=remaining-1 WHERE id=r.id;
  UPDATE taste_runtime.provider_state SET send_id=ref,send_until=db_now+interval '20 seconds',
    allocated_bytes=allocated_bytes+2105344 WHERE id=1;
  RETURN jsonb_build_object('status','ok','chargedAt',floor(now_ms));
END;
$body$;
REVOKE ALL ON ALL TABLES IN SCHEMA taste_runtime FROM PUBLIC, taste_runtime_app;
REVOKE ALL ON FUNCTION taste_runtime.provider_action(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION taste_runtime.provider_action(text,text,jsonb) TO taste_runtime_app;
