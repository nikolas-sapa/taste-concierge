-- Additive replacement. Existing V1 budgets and all send/capture/fence transitions are retained.
-- No policy initialization, history deletion, halt reset or counter reset occurs here.
CREATE OR REPLACE FUNCTION taste_runtime.valid_application_policy(policy jsonb, now_ms numeric)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog
AS $validate$
DECLARE
  field text;
  item jsonb;
  allowance jsonb := policy->'allowance';
  payload jsonb := policy->'payload';
BEGIN
  IF jsonb_typeof(policy) IS DISTINCT FROM 'object' OR
    (SELECT count(*) FROM jsonb_object_keys(policy))<>13 OR
    policy - ARRAY['version','authority','providerUsageUnknown','providerQuotaUnknown','eventHost','credentialSha256',
      'source','financialBasis','checkedAt','expiresAt','minIntervalMs','allowance','payload'] <> '{}'::jsonb OR
    policy->'version' IS DISTINCT FROM '2'::jsonb OR policy->>'authority' IS DISTINCT FROM 'application-allowance' OR
    policy->'providerUsageUnknown' IS DISTINCT FROM 'true'::jsonb OR policy->'providerQuotaUnknown' IS DISTINCT FROM 'true'::jsonb OR
    policy->>'eventHost' IS DISTINCT FROM 'https://hackathon.api.qloo.com' OR
    jsonb_typeof(policy->'credentialSha256') IS DISTINCT FROM 'string' OR (policy->>'credentialSha256') !~ '^[a-f0-9]{64}$' OR
    policy->>'financialBasis' IS DISTINCT FROM 'event-no-disclosed-fee' OR
    jsonb_typeof(policy->'source') IS DISTINCT FROM 'string' OR length(btrim(policy->>'source'))<1 OR length(policy->>'source')>500 OR
    jsonb_typeof(allowance) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(allowance))<>3 OR
    allowance - ARRAY['id','ceiling','knownBeforeLedger'] <> '{}'::jsonb OR jsonb_typeof(allowance->'id') IS DISTINCT FROM 'string' OR
    length(btrim(allowance->>'id'))<1 OR length(allowance->>'id')>500 THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['checkedAt','expiresAt','minIntervalMs'] LOOP
    IF jsonb_typeof(policy->field) IS DISTINCT FROM 'number' OR (policy->>field)::numeric<0 OR
      (policy->>field)::numeric>9007199254740991 OR trunc((policy->>field)::numeric)<>(policy->>field)::numeric THEN RETURN false; END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['ceiling','knownBeforeLedger'] LOOP
    IF jsonb_typeof(allowance->field) IS DISTINCT FROM 'number' OR (allowance->>field)::numeric<0 OR
      (allowance->>field)::numeric>9007199254740991 OR trunc((allowance->>field)::numeric)<>(allowance->>field)::numeric THEN RETURN false; END IF;
  END LOOP;
  IF (policy->>'checkedAt')::numeric>now_ms OR (policy->>'expiresAt')::numeric<=now_ms OR
    (policy->>'expiresAt')::numeric>1794890700000 OR (policy->>'minIntervalMs')::numeric<5000 OR
    (policy->>'minIntervalMs')::numeric>45000 OR (allowance->>'ceiling')::numeric<1 OR
    (allowance->>'knownBeforeLedger')::numeric>(allowance->>'ceiling')::numeric THEN RETURN false; END IF;
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR jsonb_typeof(payload->'categoryTagIds') IS DISTINCT FROM 'object' OR
    jsonb_typeof(payload->'origin') IS DISTINCT FROM 'object' OR jsonb_typeof(payload->'athensCityNames') IS DISTINCT FROM 'array' OR
    jsonb_array_length(payload->'athensCityNames')<1 OR jsonb_array_length(payload->'athensCityNames')>30 THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['dining','attractions'] LOOP
    IF jsonb_typeof(payload->'categoryTagIds'->field) IS DISTINCT FROM 'string' OR
      length(btrim(payload->'categoryTagIds'->>field))<1 OR length(payload->'categoryTagIds'->>field)>500 THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(payload->'origin'->'latitude') IS DISTINCT FROM 'number' OR
    jsonb_typeof(payload->'origin'->'longitude') IS DISTINCT FROM 'number' OR
    abs((payload->'origin'->>'latitude')::numeric)>90 OR abs((payload->'origin'->>'longitude')::numeric)>180 THEN RETURN false; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(payload->'athensCityNames') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'string' OR length(btrim(item#>>'{}'))<1 OR length(item#>>'{}')>500 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$validate$;
REVOKE ALL ON FUNCTION taste_runtime.valid_application_policy(jsonb,numeric) FROM PUBLIC, taste_runtime_app;

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
  IF p.policy IS NULL OR p.halted THEN RETURN jsonb_build_object('status','configuration'); END IF;
  IF p.policy->'version' = '2'::jsonb THEN
    IF NOT taste_runtime.valid_application_policy(p.policy,now_ms) THEN RETURN jsonb_build_object('status','configuration'); END IF;
    -- Provenance only. Lifetime consumption below deliberately ignores all identifiers.
    active_ids := jsonb_build_array(p.policy->'allowance'->'id');
  ELSE
  IF p.policy->>'version' IS DISTINCT FROM '1' OR p.policy->'verified' IS DISTINCT FROM 'true'::jsonb OR
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
  IF p.policy->'version' = '2'::jsonb THEN
    SELECT count(*) INTO charged FROM taste_runtime.provider_attempts;
    IF (p.policy->'allowance'->>'knownBeforeLedger')::bigint+charged+reserved+requested>
      (p.policy->'allowance'->>'ceiling')::bigint THEN RETURN jsonb_build_object('status','limited'); END IF;
  ELSE
  FOR policy_window IN SELECT * FROM jsonb_array_elements(windows) LOOP
    SELECT count(*) INTO charged FROM taste_runtime.provider_attempts WHERE window_ids ? (policy_window->>'id');
    IF (policy_window->>'usedBeforeLedger')::bigint+charged+reserved+requested>(policy_window->>'ceiling')::bigint THEN
      RETURN jsonb_build_object('status','limited');
    END IF;
  END LOOP;
  END IF;
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
