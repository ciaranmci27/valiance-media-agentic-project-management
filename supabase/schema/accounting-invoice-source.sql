-- Draft source module. Package after source and snapshot acceptance.
CREATE TABLE public.invoice_accounting_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), source_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.invoice_accounting_settings(singleton) VALUES(true);
CREATE TABLE public.invoice_accounting_heads (
 invoice_id uuid PRIMARY KEY, revision bigint NOT NULL CHECK(revision>0), deleted boolean NOT NULL,
 body jsonb NOT NULL, body_hash text NOT NULL CHECK(body_hash ~ '^[0-9a-f]{64}$'), observed_at timestamptz NOT NULL,
 first_observed_at timestamptz NOT NULL, history_origin text NOT NULL CHECK(history_origin IN ('created','bootstrap'))
);
CREATE TABLE public.invoice_accounting_versions (
 invoice_id uuid NOT NULL REFERENCES public.invoice_accounting_heads(invoice_id), revision bigint NOT NULL,
 deleted boolean NOT NULL, body jsonb NOT NULL, body_hash text NOT NULL CHECK(body_hash ~ '^[0-9a-f]{64}$'), observed_at timestamptz NOT NULL,
 change_kind text NOT NULL CHECK(change_kind IN ('created','changed','deleted','bootstrap')),
 PRIMARY KEY(invoice_id,revision)
);
CREATE TABLE public.invoice_accounting_snapshots (
 id uuid PRIMARY KEY, source_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '1 hour',
 item_count integer NOT NULL DEFAULT 0, manifest_hash text NOT NULL DEFAULT ''
);
CREATE TABLE public.invoice_accounting_snapshot_items (
 snapshot_id uuid NOT NULL REFERENCES public.invoice_accounting_snapshots(id) ON DELETE CASCADE, ordinal integer NOT NULL CHECK(ordinal>=0),
 invoice_id uuid NOT NULL, revision bigint NOT NULL, body_hash text NOT NULL, record jsonb NOT NULL,
 PRIMARY KEY(snapshot_id,ordinal), UNIQUE(snapshot_id,invoice_id)
);
CREATE OR REPLACE FUNCTION public.invoice_accounting_lock() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM 1 FROM public.invoice_accounting_settings WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INVOICE_SOURCE_NOT_CONFIGURED'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.invoice_accounting_statement_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN PERFORM public.invoice_accounting_lock();RETURN NULL;END $$;
CREATE OR REPLACE FUNCTION public.invoice_accounting_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'INVOICE_SOURCE_IMMUTABLE'; END $$;
CREATE OR REPLACE FUNCTION public.invoice_accounting_cents(p_value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE value text:=p_value#>>'{}';n numeric;
BEGIN
 IF value IS NULL OR length(value)>64 OR value !~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN NULL; END IF;
 n:=value::numeric*100;
 IF n<>trunc(n) OR abs(n)>9223372036854775807 THEN RETURN NULL; END IF;
 RETURN trunc(n)::text;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.invoice_accounting_date(p_value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE d date;
BEGIN
 IF p_value IS NULL OR p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN NULL; END IF;
 d:=p_value::date;
 IF d<'1900-01-01'::date OR d>'2100-12-31'::date OR to_char(d,'YYYY-MM-DD')<>p_value THEN RETURN NULL; END IF;
 RETURN p_value;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.invoice_accounting_body(p_row jsonb,p_project jsonb,p_customer jsonb,p_deleted boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE items jsonb:=coalesce(nullif(p_row->'line_items','null'),'[]');lines jsonb:='[]';issues jsonb:='[]';x jsonb;
 header text:=public.invoice_accounting_cents(p_row->'amount');amount text;rate text;tax numeric;subtotal numeric:=0;taxable numeric:=0;valid_lines boolean:=true;v_id text;pos integer:=0;
BEGIN
 IF header IS NULL OR header::numeric<0 THEN issues:=issues||'"invalid_header_amount"'::jsonb; END IF;
 IF public.invoice_accounting_date(p_row->>'date') IS NULL THEN issues:=issues||'"invalid_issue_date"'::jsonb; END IF;
 IF nullif(p_row->>'due_date','') IS NOT NULL AND public.invoice_accounting_date(p_row->>'due_date') IS NULL THEN issues:=issues||'"invalid_due_date"'::jsonb; END IF;
 IF nullif(p_row->>'paid_date','') IS NOT NULL AND public.invoice_accounting_date(p_row->>'paid_date') IS NULL THEN issues:=issues||'"invalid_claimed_payment_date"'::jsonb; END IF;
 IF jsonb_typeof(items)<>'array' THEN
  issues:=issues||'"unsupported_line_count"'::jsonb;valid_lines:=false;items:='[]';
 ELSIF jsonb_array_length(items)>200 THEN
  issues:=issues||'"unsupported_line_count"'::jsonb;valid_lines:=false;items:='[]';
 ELSIF jsonb_array_length(items)=0 THEN
  items:=jsonb_build_array(jsonb_build_object('id','header','item_type',p_row->>'invoice_type','amount',p_row->'amount','description',p_row->>'description','position',0));
 END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(items) LOOP
  amount:=public.invoice_accounting_cents(x->'amount');v_id:=coalesce(nullif(x->>'id',''),'legacy-position-'||pos::text);
  IF amount IS NULL OR amount::numeric<0 THEN valid_lines:=false;issues:=issues||'"invalid_line_amount"'::jsonb;
  ELSE subtotal:=subtotal+amount::numeric;IF x->>'item_type'<>'reimbursement' THEN taxable:=taxable+amount::numeric; END IF; END IF;
  IF coalesce(x->>'item_type','') NOT IN ('hourly','fixed','recurring','reimbursement') THEN valid_lines:=false;issues:=issues||'"unsupported_line_type"'::jsonb; END IF;
  IF length(v_id)>200 OR EXISTS(SELECT 1 FROM jsonb_array_elements(lines) l WHERE l->>'id'=v_id) THEN valid_lines:=false;issues:=issues||'"invalid_line_identity"'::jsonb; END IF;
  lines:=lines||jsonb_build_array(jsonb_build_object('id',left(v_id,200),'position',pos,'type',x->>'item_type','amount_cents',amount,'description',left(coalesce(x->>'description',''),2000),'identity_basis',CASE WHEN nullif(x->>'id','') IS NULL THEN 'position' ELSE 'source_id' END,'service_start_date',public.invoice_accounting_date(x->>'service_start_date'),'service_end_date',public.invoice_accounting_date(x->>'service_end_date')));pos:=pos+1;
 END LOOP;
 IF valid_lines AND header IS NOT NULL AND subtotal<>header::numeric THEN valid_lines:=false;issues:=issues||'"header_line_difference"'::jsonb; END IF;
 rate:=public.invoice_accounting_cents(coalesce(nullif(p_project->'tax_rate','null'),'0'));
 IF rate IS NULL OR rate::numeric<0 THEN issues:=issues||'"invalid_source_tax_rate"'::jsonb;tax:=NULL;
 ELSIF valid_lines THEN tax:=round(taxable*rate::numeric/10000); END IF;
 RETURN jsonb_build_object('schema_version',2,'deleted',p_deleted,'currency','USD',
 'invoice',jsonb_build_object('id',p_row->>'id','number',left(coalesce(p_row->>'invoice_number',''),250),'status',p_row->>'status','payment_claimed',p_row->>'status'='paid','issue_date',public.invoice_accounting_date(p_row->>'date'),'due_date',public.invoice_accounting_date(p_row->>'due_date'),'claimed_payment_date',public.invoice_accounting_date(p_row->>'paid_date'),'description',left(coalesce(p_row->>'description',''),3000),'subtotal_cents',header,'total_cents',CASE WHEN valid_lines AND header IS NOT NULL AND tax IS NOT NULL THEN (header::numeric+tax)::text END,'has_source_attachment',nullif(p_row->>'file_url','') IS NOT NULL),
 'project',jsonb_build_object('id',p_row->>'project_id','name',left(coalesce(p_project->>'name',''),500)),
 'customer',CASE WHEN p_customer->>'id' IS NOT NULL THEN jsonb_build_object('id',p_customer->>'id','name',left(coalesce(p_customer->>'name',''),500),'company',left(coalesce(p_customer->>'company',''),500)) END,
 'lines',lines,'tax',jsonb_build_object('rate_basis_points',rate,'amount_cents',tax::text,'basis','current_project_pdf_formula'),
 'issues',(SELECT coalesce(jsonb_agg(DISTINCT value),'[]') FROM jsonb_array_elements(issues)));
END $$;
CREATE OR REPLACE FUNCTION public.invoice_accounting_record(p_head public.invoice_accounting_heads) RETURNS jsonb
LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('source_id',(SELECT source_id FROM public.invoice_accounting_settings WHERE singleton),'invoice_id',p_head.invoice_id,'revision',p_head.revision::text,'observed_at',p_head.observed_at,'first_observed_at',p_head.first_observed_at,'history_origin',p_head.history_origin,'hash',p_head.body_hash,'body',p_head.body::text);
$$;
CREATE OR REPLACE FUNCTION public.invoice_accounting_capture(p_id uuid,p_deleted_row jsonb DEFAULT NULL,p_bootstrap boolean DEFAULT false,p_emit boolean DEFAULT true) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE prior public.invoice_accounting_heads;head public.invoice_accounting_heads;source_row jsonb;project_row jsonb;customer_row jsonb;body jsonb;hash text;deleted boolean;
 event_uuid uuid;public_id text;sequence_value bigint;payload jsonb;observed timestamptz;
BEGIN
 PERFORM public.invoice_accounting_lock();
 observed:=clock_timestamp();
 SELECT * INTO prior FROM public.invoice_accounting_heads WHERE invoice_id=p_id;
 SELECT to_jsonb(i),to_jsonb(p),to_jsonb(c) INTO source_row,project_row,customer_row FROM public.project_invoices i JOIN public.projects p ON p.id=i.project_id LEFT JOIN public.project_contacts pc ON pc.project_id=p.id AND pc.is_primary_client LEFT JOIN public.contacts c ON c.id=pc.contact_id WHERE i.id=p_id;
 deleted:=source_row IS NULL;
 IF deleted THEN
  IF prior.invoice_id IS NOT NULL THEN body:=jsonb_set(prior.body,'{deleted}','true');
  ELSIF p_deleted_row IS NOT NULL THEN
   body:=public.invoice_accounting_body(p_deleted_row,'{}','{}',true);
   body:=jsonb_set(jsonb_set(body,'{invoice,total_cents}','null'),'{tax}',jsonb_build_object('rate_basis_points',NULL,'amount_cents',NULL,'basis','unavailable_deleted_source'));
   body:=jsonb_set(body,'{issues}',body->'issues'||'"deleted_source_context_unavailable"'::jsonb);
  ELSE RETURN; END IF;
 ELSE body:=public.invoice_accounting_body(source_row,project_row,customer_row,false); END IF;
 hash:=encode(sha256(convert_to(body::text,'UTF8')),'hex');
 IF prior.invoice_id IS NOT NULL AND prior.body_hash=hash THEN RETURN; END IF;
 INSERT INTO public.invoice_accounting_heads(invoice_id,revision,deleted,body,body_hash,observed_at,first_observed_at,history_origin)
 VALUES(p_id,coalesce(prior.revision,0)+1,deleted,body,hash,observed,coalesce(prior.first_observed_at,observed),coalesce(prior.history_origin,CASE WHEN p_bootstrap OR deleted THEN 'bootstrap' ELSE 'created' END))
 ON CONFLICT(invoice_id) DO UPDATE SET revision=EXCLUDED.revision,deleted=EXCLUDED.deleted,body=EXCLUDED.body,body_hash=EXCLUDED.body_hash,observed_at=EXCLUDED.observed_at RETURNING * INTO head;
 INSERT INTO public.invoice_accounting_versions(invoice_id,revision,deleted,body,body_hash,observed_at,change_kind)
 VALUES(head.invoice_id,head.revision,head.deleted,head.body,head.body_hash,head.observed_at,CASE WHEN deleted THEN 'deleted' WHEN prior.invoice_id IS NOT NULL THEN 'changed' WHEN p_bootstrap THEN 'bootstrap' ELSE 'created' END);
 IF p_emit THEN
  public_id:='evt_'||replace(gen_random_uuid()::text,'-','');sequence_value:=nextval('public.webhook_event_seq');
  payload:=jsonb_build_object('id',public_id,'type','invoice.lifecycle','schema_version',2,'created_at',observed,'record',public.invoice_accounting_record(head));
  INSERT INTO public.webhook_events(event_id,sequence,event_type,resource_type,resource_id,payload) VALUES(public_id,sequence_value,'invoice.lifecycle','invoice',p_id,payload) RETURNING id INTO event_uuid;
  INSERT INTO public.webhook_deliveries(webhook_event_id,endpoint_id) SELECT event_uuid,id FROM public.webhook_endpoints WHERE is_active AND 'invoice.lifecycle'=ANY(events);
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.invoice_accounting_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE key uuid;old_key uuid;new_key uuid;
BEGIN
 IF TG_TABLE_NAME='project_invoices' THEN
  PERFORM public.invoice_accounting_capture(CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END,CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) END,false,true);
 ELSIF TG_TABLE_NAME='projects' THEN
  IF TG_OP='UPDATE' AND NEW.name IS NOT DISTINCT FROM OLD.name AND NEW.tax_rate IS NOT DISTINCT FROM OLD.tax_rate THEN RETURN NEW; END IF;
  FOR key IN SELECT id FROM public.project_invoices WHERE project_id=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END ORDER BY id LOOP PERFORM public.invoice_accounting_capture(key); END LOOP;
 ELSIF TG_TABLE_NAME='contacts' THEN
  IF TG_OP='UPDATE' AND NEW.name IS NOT DISTINCT FROM OLD.name AND NEW.company IS NOT DISTINCT FROM OLD.company THEN RETURN NEW; END IF;
  FOR key IN SELECT i.id FROM public.project_invoices i JOIN public.project_contacts pc ON pc.project_id=i.project_id WHERE pc.is_primary_client AND pc.contact_id=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END ORDER BY i.id LOOP PERFORM public.invoice_accounting_capture(key); END LOOP;
 ELSE
  old_key:=CASE WHEN TG_OP<>'INSERT' THEN OLD.project_id END;new_key:=CASE WHEN TG_OP<>'DELETE' THEN NEW.project_id END;
  FOR key IN SELECT id FROM public.project_invoices WHERE project_id IN (old_key,new_key) ORDER BY id LOOP PERFORM public.invoice_accounting_capture(key); END LOOP;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE OR REPLACE FUNCTION public.invoice_accounting_snapshot(p_id uuid,p_cursor integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE saved public.invoice_accounting_snapshots;key uuid;records jsonb;next_cursor integer;
BEGIN
 IF p_id IS NULL OR p_cursor<0 THEN RAISE EXCEPTION 'INVOICE_SNAPSHOT_INPUT'; END IF;
 IF p_cursor IS NULL THEN
  PERFORM public.invoice_accounting_lock();
  SELECT * INTO saved FROM public.invoice_accounting_snapshots WHERE id=p_id;
  IF NOT FOUND THEN
   -- Full authoritative comparison is independent of event delivery/sequence.
   FOR key IN SELECT id FROM public.project_invoices ORDER BY id LOOP PERFORM public.invoice_accounting_capture(key,NULL,true,true); END LOOP;
   FOR key IN SELECT h.invoice_id FROM public.invoice_accounting_heads h WHERE NOT h.deleted AND NOT EXISTS(SELECT 1 FROM public.project_invoices i WHERE i.id=h.invoice_id) ORDER BY h.invoice_id LOOP PERFORM public.invoice_accounting_capture(key); END LOOP;
   INSERT INTO public.invoice_accounting_snapshots(id,source_id) SELECT p_id,source_id FROM public.invoice_accounting_settings WHERE singleton;
   INSERT INTO public.invoice_accounting_snapshot_items(snapshot_id,ordinal,invoice_id,revision,body_hash,record)
   SELECT p_id,row_number() OVER(ORDER BY invoice_id)-1,invoice_id,revision,body_hash,public.invoice_accounting_record(h) FROM public.invoice_accounting_heads h;
   UPDATE public.invoice_accounting_snapshots SET item_count=(SELECT count(*) FROM public.invoice_accounting_snapshot_items WHERE snapshot_id=p_id),manifest_hash=(SELECT encode(sha256(convert_to(coalesce(string_agg(invoice_id::text||':'||revision::text||':'||body_hash,E'\n' ORDER BY invoice_id),''),'UTF8')),'hex') FROM public.invoice_accounting_snapshot_items WHERE snapshot_id=p_id) WHERE id=p_id;
   DELETE FROM public.invoice_accounting_snapshots WHERE expires_at<now()-interval '2 days';
   SELECT * INTO saved FROM public.invoice_accounting_snapshots WHERE id=p_id;
  END IF;
  IF saved.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'INVOICE_SNAPSHOT_EXPIRED'; END IF;
  RETURN to_jsonb(saved)||jsonb_build_object('schema_version',2);
 END IF;
 SELECT * INTO saved FROM public.invoice_accounting_snapshots WHERE id=p_id;
 IF NOT FOUND OR saved.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'INVOICE_SNAPSHOT_EXPIRED'; END IF;
 IF p_cursor>saved.item_count THEN RAISE EXCEPTION 'INVOICE_SNAPSHOT_INPUT'; END IF;
 WITH candidates AS (
  SELECT ordinal,record,sum(octet_length(record::text)) OVER(ORDER BY ordinal) bytes FROM (SELECT ordinal,record FROM public.invoice_accounting_snapshot_items WHERE snapshot_id=p_id AND ordinal>=p_cursor ORDER BY ordinal LIMIT 100) q
 ) SELECT coalesce(jsonb_agg(record ORDER BY ordinal),'[]'),coalesce(max(ordinal)+1,p_cursor) INTO records,next_cursor FROM candidates WHERE bytes<=2000000 OR ordinal=p_cursor;
 RETURN jsonb_build_object('schema_version',2,'id',saved.id,'source_id',saved.source_id,'created_at',saved.created_at,'manifest_hash',saved.manifest_hash,'item_count',saved.item_count,'cursor',p_cursor,'next_cursor',CASE WHEN next_cursor<saved.item_count THEN next_cursor END,'records',records);
END $$;
DO $$ DECLARE t text;key uuid;legacy jsonb;BEGIN
 FOREACH t IN ARRAY ARRAY['project_invoices','projects','contacts','project_contacts'] LOOP
  EXECUTE format('CREATE TRIGGER invoice_accounting_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.invoice_accounting_statement_lock()',t);
  EXECUTE format('CREATE TRIGGER invoice_accounting_change AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.invoice_accounting_change()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['invoice_accounting_settings','invoice_accounting_heads','invoice_accounting_versions','invoice_accounting_snapshots','invoice_accounting_snapshot_items'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
 END LOOP;
 FOR key IN SELECT id FROM public.project_invoices ORDER BY id LOOP PERFORM public.invoice_accounting_capture(key,NULL,true,false); END LOOP;
 FOR key,legacy IN SELECT DISTINCT ON(resource_id) resource_id,payload FROM public.webhook_events WHERE event_type='invoice.deleted' AND resource_id IS NOT NULL ORDER BY resource_id,sequence DESC LOOP
  IF NOT EXISTS(SELECT 1 FROM public.invoice_accounting_heads WHERE invoice_id=key) THEN PERFORM public.invoice_accounting_capture(key,coalesce(legacy->'data'->'invoice','{}')||jsonb_build_object('id',key,'line_items',coalesce(legacy->'data'->'line_items','[]')),true,false); END IF;
 END LOOP;
END $$;
CREATE TRIGGER invoice_accounting_version_immutable BEFORE UPDATE OR DELETE ON public.invoice_accounting_versions FOR EACH ROW EXECUTE FUNCTION public.invoice_accounting_append_only();
REVOKE ALL ON FUNCTION public.invoice_accounting_lock(),public.invoice_accounting_statement_lock(),public.invoice_accounting_append_only(),public.invoice_accounting_cents(jsonb),public.invoice_accounting_date(text),public.invoice_accounting_body(jsonb,jsonb,jsonb,boolean),public.invoice_accounting_record(public.invoice_accounting_heads),public.invoice_accounting_capture(uuid,jsonb,boolean,boolean),public.invoice_accounting_change(),public.invoice_accounting_snapshot(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.invoice_accounting_snapshot(uuid,integer) TO service_role;

ALTER TABLE public.webhook_deliveries ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.webhook_deliveries ADD COLUMN IF NOT EXISTS attempt_token uuid;
ALTER TABLE public.webhook_deliveries ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON public.webhook_deliveries(next_attempt_at) WHERE status IN ('pending','delivering');

-- A changed result type requires replacement. Callers retain the existing name.
DROP FUNCTION public.claim_webhook_deliveries(integer);
CREATE OR REPLACE FUNCTION public.claim_webhook_deliveries(p_limit integer DEFAULT 20)
RETURNS TABLE(delivery_id uuid,attempts integer,attempt_token uuid,endpoint_id uuid,endpoint_url text,endpoint_secret text,event_public_id text,event_type text,event_sequence text,payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'WEBHOOK_LIMIT'; END IF;
 -- Serialize claims briefly, then release before network I/O. Only one active
 -- delivery per endpoint/resource may reach even a legacy receiver at a time.
 PERFORM public.invoice_accounting_lock();
 UPDATE public.webhook_deliveries d SET status='failed',last_error='Delivery lease expired after the retry budget was used.',lease_expires_at=NULL,attempt_token=NULL
 FROM public.webhook_events ev WHERE ev.id=d.webhook_event_id AND ev.event_type='invoice.lifecycle' AND d.status='delivering' AND d.lease_expires_at<=now() AND d.attempts>=8;
 RETURN QUERY WITH eligible AS (
  SELECT d.id,row_number() OVER(PARTITION BY d.endpoint_id,coalesce(ev.resource_id,ev.id) ORDER BY ev.sequence,d.id) priority
  FROM public.webhook_deliveries d JOIN public.webhook_events ev ON ev.id=d.webhook_event_id JOIN public.webhook_endpoints ep ON ep.id=d.endpoint_id
  WHERE ep.is_active AND ((d.status='pending' AND d.next_attempt_at<=now()) OR (d.status='delivering' AND d.lease_expires_at<=now() AND ev.event_type='invoice.lifecycle' AND d.attempts<8))
  AND NOT EXISTS(SELECT 1 FROM public.webhook_deliveries other_d JOIN public.webhook_events other_ev ON other_ev.id=other_d.webhook_event_id WHERE other_d.endpoint_id=d.endpoint_id AND coalesce(other_ev.resource_id,other_ev.id)=coalesce(ev.resource_id,ev.id) AND other_d.id<>d.id AND other_d.status='delivering' AND coalesce(other_d.lease_expires_at,'infinity')>now())
 ),chosen AS (
  SELECT d.id FROM public.webhook_deliveries d JOIN eligible c ON c.id=d.id WHERE c.priority=1 ORDER BY d.created_at,d.id FOR UPDATE OF d SKIP LOCKED LIMIT p_limit
 ) UPDATE public.webhook_deliveries d SET status='delivering',attempts=d.attempts+1,last_attempt_at=now(),attempt_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes'
 FROM chosen,public.webhook_events ev,public.webhook_endpoints ep WHERE d.id=chosen.id AND ev.id=d.webhook_event_id AND ep.id=d.endpoint_id
 RETURNING d.id,d.attempts,d.attempt_token,ep.id,ep.url,ep.secret,ev.event_id,ev.event_type,ev.sequence::text,ev.payload;
END $$;
CREATE OR REPLACE FUNCTION public.complete_webhook_delivery(p_id uuid,p_attempt uuid,p_status integer,p_error text,p_response text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d public.webhook_deliveries;event_kind text;success boolean;retry boolean;
BEGIN
 SELECT * INTO d FROM public.webhook_deliveries WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR d.status<>'delivering' OR p_attempt IS NULL OR d.attempt_token IS DISTINCT FROM p_attempt OR d.lease_expires_at IS NULL OR d.lease_expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('accepted',false); END IF;
 SELECT event_type INTO event_kind FROM public.webhook_events WHERE id=d.webhook_event_id;
 success:=coalesce(p_status BETWEEN 200 AND 299,false);retry:=NOT success AND event_kind='invoice.lifecycle' AND d.attempts<8;
 UPDATE public.webhook_deliveries SET status=CASE WHEN success THEN 'succeeded' WHEN retry THEN 'pending' ELSE 'failed' END,
  last_status_code=p_status,last_error=CASE WHEN success THEN NULL ELSE left(coalesce(p_error,'Request failed'),1000) END,last_response=left(p_response,2000),
  delivered_at=CASE WHEN success THEN now() ELSE delivered_at END,attempt_token=NULL,lease_expires_at=NULL,
  next_attempt_at=CASE WHEN retry THEN now()+make_interval(secs=>least(21600,60*power(2,least(d.attempts-1,10))::integer)+floor(random()*30)::integer) ELSE next_attempt_at END
 WHERE id=d.id;
 IF success THEN UPDATE public.webhook_endpoints SET last_delivery_at=now() WHERE id=d.endpoint_id; END IF;
 RETURN jsonb_build_object('accepted',true,'delivered',success,'retry_scheduled',retry);
END $$;
CREATE OR REPLACE FUNCTION public.requeue_webhook_delivery(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d public.webhook_deliveries;
BEGIN
 IF public.has_permission('webhooks.manage') IS DISTINCT FROM true THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT * INTO d FROM public.webhook_deliveries WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'WEBHOOK_NOT_FOUND'; END IF;
 IF d.status='delivering' AND d.lease_expires_at>now() THEN RAISE EXCEPTION 'WEBHOOK_BUSY'; END IF;
 UPDATE public.webhook_deliveries SET status='pending',attempts=0,last_error=NULL,next_attempt_at=now(),attempt_token=NULL,lease_expires_at=NULL WHERE id=d.id;
END $$;
REVOKE ALL ON FUNCTION public.claim_webhook_deliveries(integer),public.complete_webhook_delivery(uuid,uuid,integer,text,text),public.requeue_webhook_delivery(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_webhook_deliveries(integer),public.complete_webhook_delivery(uuid,uuid,integer,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.requeue_webhook_delivery(uuid) TO authenticated;
-- Browser callers may only reset a delivery through the permission-checked RPC.
DROP POLICY IF EXISTS webhook_deliveries_requeue ON public.webhook_deliveries;
REVOKE UPDATE ON public.webhook_deliveries FROM authenticated;
