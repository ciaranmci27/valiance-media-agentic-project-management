-- Security hardening (break-it round, 2026-11-27).
--
-- Safe to run twice; works with the 2.0.49 code (every path that writes these
-- tables from the browser keeps working; server routes use the service role).
--
-- 1. Storage: who reads, uploads, changes or deletes a stored file is decided
--    by the record it belongs to, through pm.storage_object_allowed():
--    - pm-entity-files: {project|lead|contact}/{id}/... follows that record's
--      file rules (files.read / files.upload, files.manage or the uploader to
--      change or delete); invoices/{project}/... follows invoices.read /
--      invoices.manage on that project.
--    - pm-portal-files: updates/{project}/... follows portal.read /
--      portal.manage on that project.
--    - pm-avatars: still public to read (pictures show everywhere, signed out
--      on the portal too); team/{member}.jpg is written only by that member,
--      a holder of team.manage, or one of the agent's owners (by name or through a group);
--      contacts/{contact}.jpg by contacts.manage on a contact they reach;
--      portal/{project}.* by portal.manage on that project.
--    pm-entity-files and pm-portal-files become private: the app serves them
--    through short signed links (/api/storage/file, the portal routes). The
--    pre-2.0 buckets of an upgraded install (entity-files, portal-files,
--    avatars) lose the app's old member-wide write policies, and the two file
--    buckets turn private too; the app signs their files the same way.
-- 2. task_comments: a comment stays on its task and keeps its author. The
--    update policy checks the task on both sides, and a trigger refuses a
--    browser write that moves a comment or changes its author.
-- 3. time_entry_tasks: read with the time entry; written only by whoever may
--    edit that entry, and only with tasks of the entry's project.
-- 4. Manage without View all: leads.manage, contacts.manage and
--    tasks.manage_all no longer read or change every row; they act on the
--    leads, contacts and tasks the person reaches (and what they created).
--    projects_manage reads only reachable projects.
-- 5. Personal inboxes: verification is the server's. A browser write never
--    sets verified_at or verification_code, and changing an inbox's address
--    from the browser clears its verification.
-- 6. Server-set columns: a browser insert or update of a task or comment
--    never sets created_at, a task's completed_at (outside a status change),
--    its claim or its repeat count.
-- 7. Trash: soft_delete_record checks permission before saying whether a
--    record exists, and restore_record answers a missing record as it answers
--    one the member may not restore.
-- 8. Webhooks: an endpoint receives a project's events only while its maker
--    reads that project.
-- 9. Avatars: team_members.avatar and contacts.avatar_url hold only an https
--    picture link or a path on the app.

-- ---------------------------------------------------------------------------
-- 1. Storage
-- ---------------------------------------------------------------------------

-- Whether the signed-in member may read, write (upload) or delete (also
-- change) a stored object, from its bucket and path. Old bucket names (before
-- 2.0) follow the same rules as their pm- twins. p_owner is the object's
-- owner (storage.objects.owner), so an uploader may remove what they put.
CREATE OR REPLACE FUNCTION pm.storage_object_allowed(p_bucket text, p_name text, p_action text, p_owner uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  me uuid := pm.current_team_member_id();
  v_bucket text := CASE WHEN p_bucket LIKE 'pm-%' THEN p_bucket ELSE 'pm-' || coalesce(p_bucket, '') END;
  v_parts text[] := string_to_array(coalesce(p_name, ''), '/');
  v_depth integer := coalesce(array_length(string_to_array(coalesce(p_name, ''), '/'), 1), 0);
  v_kind text;
  v_target_text text;
  v_target uuid;
BEGIN
  IF me IS NULL OR p_action IS NULL OR p_action NOT IN ('read', 'write', 'delete') OR v_depth < 2 THEN
    RETURN false;
  END IF;
  v_kind := v_parts[1];
  IF v_bucket = 'pm-avatars' THEN
    IF p_action = 'read' THEN
      RETURN true;
    END IF;
    -- One picture per record: <kind>/<id>.<ext>
    IF v_depth <> 2 THEN
      RETURN false;
    END IF;
    v_target_text := substring(v_parts[2] FROM '^([0-9A-Fa-f-]{36})(\.[A-Za-z0-9]{1,8})?$');
  ELSE
    -- <kind>/<id>/<file name>
    IF v_depth < 3 OR v_parts[v_depth] = '' THEN
      RETURN false;
    END IF;
    v_target_text := v_parts[2];
  END IF;
  IF v_target_text IS NULL
     OR v_target_text !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$' THEN
    RETURN false;
  END IF;
  v_target := v_target_text::uuid;

  IF v_bucket = 'pm-entity-files' THEN
    IF v_kind IN ('project', 'lead', 'contact') THEN
      IF NOT pm.can_access_file_entity(v_kind, v_target) THEN
        RETURN false;
      END IF;
      RETURN CASE p_action
        WHEN 'read' THEN pm.has_permission('files.read') OR pm.has_permission('files.manage')
        WHEN 'write' THEN pm.has_permission('files.upload') OR pm.has_permission('files.manage')
        ELSE pm.has_permission('files.manage') OR (p_owner IS NOT NULL AND p_owner = auth.uid())
      END;
    ELSIF v_kind = 'invoices' THEN
      RETURN pm.can_access_project(v_target) AND (
        pm.has_permission('invoices.manage')
        OR (p_action = 'read' AND pm.has_permission('invoices.read'))
      );
    END IF;
    RETURN false;
  ELSIF v_bucket = 'pm-portal-files' THEN
    IF v_kind = 'updates' THEN
      RETURN pm.can_access_project(v_target) AND (
        pm.has_permission('portal.manage')
        OR (p_action = 'read' AND pm.has_permission('portal.read'))
      );
    END IF;
    RETURN false;
  ELSIF v_bucket = 'pm-avatars' THEN
    IF v_kind = 'team' THEN
      IF pm.has_permission('team.manage') THEN
        RETURN true;
      END IF;
      -- A person's own picture (an agent's is its managers', as canManageAgent says).
      IF v_target = me THEN
        RETURN NOT EXISTS (SELECT 1 FROM pm.team_members self_row WHERE self_row.id = me AND self_row.role = 'agent');
      END IF;
      -- An agent's picture: its owners, by name, or as an active person in a
      -- live group that owns it (isAgentOwner in agent-owners.ts).
      RETURN EXISTS (SELECT 1 FROM pm.team_members agent WHERE agent.id = v_target AND agent.role = 'agent')
        AND (
          EXISTS (SELECT 1 FROM pm.agent_owners owner_row WHERE owner_row.agent_id = v_target AND owner_row.member_id = me)
          OR (
            EXISTS (SELECT 1 FROM pm.team_members person WHERE person.id = me AND person.role <> 'agent' AND coalesce(person.status, 'active') = 'active')
            AND EXISTS (
              SELECT 1 FROM pm.agent_owner_groups owner_group
              JOIN pm.groups owning ON owning.id = owner_group.group_id AND owning.deleted_at IS NULL
              JOIN pm.group_members membership ON membership.group_id = owner_group.group_id AND membership.member_id = me
              WHERE owner_group.agent_id = v_target
            )
          )
        );
    ELSIF v_kind = 'contacts' THEN
      RETURN pm.has_permission('contacts.manage') AND EXISTS (
        SELECT 1 FROM pm.contacts contact
        WHERE contact.id = v_target AND contact.deleted_at IS NULL
          AND (contact.created_by = me OR pm.can_access_file_entity('contact', v_target))
      );
    ELSIF v_kind = 'portal' THEN
      RETURN pm.has_permission('portal.manage') AND pm.can_access_project(v_target);
    END IF;
    RETURN false;
  END IF;
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION pm.storage_object_allowed(text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.storage_object_allowed(text, text, text, uuid) TO authenticated, service_role;

UPDATE storage.buckets SET public = false WHERE id IN ('pm-entity-files', 'pm-portal-files') AND public;

-- Entity files (project, lead and contact files, invoice PDFs).
DROP POLICY IF EXISTS "pm: Authenticated users can upload entity files" ON storage.objects;
DROP POLICY IF EXISTS "pm: Authenticated users can update entity files" ON storage.objects;
DROP POLICY IF EXISTS "pm: Authenticated users can delete entity files" ON storage.objects;
DROP POLICY IF EXISTS "pm: Authenticated users can read entity files" ON storage.objects;
DROP POLICY IF EXISTS "pm: Entity files are read by who opens their record" ON storage.objects;
CREATE POLICY "pm: Entity files are read by who opens their record" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'pm-entity-files' AND (select pm.current_team_member_id()) IS NOT NULL AND pm.storage_object_allowed(bucket_id, name, 'read'));
DROP POLICY IF EXISTS "pm: Entity files are added by who may upload to their record" ON storage.objects;
CREATE POLICY "pm: Entity files are added by who may upload to their record" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'pm-entity-files' AND (select pm.current_team_member_id()) IS NOT NULL AND pm.storage_object_allowed(bucket_id, name, 'write'));
DROP POLICY IF EXISTS "pm: Entity files are changed by who manages them" ON storage.objects;
CREATE POLICY "pm: Entity files are changed by who manages them" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'pm-entity-files' AND (select pm.current_team_member_id()) IS NOT NULL AND pm.storage_object_allowed(bucket_id, name, 'delete', owner))
  WITH CHECK (bucket_id = 'pm-entity-files' AND (select pm.current_team_member_id()) IS NOT NULL AND pm.storage_object_allowed(bucket_id, name, 'write'));
DROP POLICY IF EXISTS "pm: Entity files are removed by who manages them" ON storage.objects;
CREATE POLICY "pm: Entity files are removed by who manages them" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'pm-entity-files' AND (select pm.current_team_member_id()) IS NOT NULL AND pm.storage_object_allowed(bucket_id, name, 'delete', owner));

-- Portal update attachments.
DROP POLICY IF EXISTS "pm: Authenticated users can upload portal files" ON storage.objects;
DROP POLICY IF EXISTS "pm: Authenticated users can update portal files" ON storage.objects;
DROP POLICY IF EXISTS "pm: Authenticated users can delete portal files" ON storage.objects;
DROP POLICY IF EXISTS "pm: Public can read portal files" ON storage.objects;
DROP POLICY IF EXISTS "pm: Portal files are read by who sees the portal" ON storage.objects;
CREATE POLICY "pm: Portal files are read by who sees the portal" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'pm-portal-files' AND (select pm.current_team_member_id()) IS NOT NULL AND pm.storage_object_allowed(bucket_id, name, 'read'));
DROP POLICY IF EXISTS "pm: Portal files are added by who manages the portal" ON storage.objects;
CREATE POLICY "pm: Portal files are added by who manages the portal" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'pm-portal-files' AND (select pm.current_team_member_id()) IS NOT NULL AND pm.storage_object_allowed(bucket_id, name, 'write'));
DROP POLICY IF EXISTS "pm: Portal files are changed by who manages the portal" ON storage.objects;
CREATE POLICY "pm: Portal files are changed by who manages the portal" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'pm-portal-files' AND (select pm.current_team_member_id()) IS NOT NULL AND pm.storage_object_allowed(bucket_id, name, 'delete', owner))
  WITH CHECK (bucket_id = 'pm-portal-files' AND (select pm.current_team_member_id()) IS NOT NULL AND pm.storage_object_allowed(bucket_id, name, 'write'));
DROP POLICY IF EXISTS "pm: Portal files are removed by who manages the portal" ON storage.objects;
CREATE POLICY "pm: Portal files are removed by who manages the portal" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'pm-portal-files' AND (select pm.current_team_member_id()) IS NOT NULL AND pm.storage_object_allowed(bucket_id, name, 'delete', owner));

-- Avatars: public to read ("pm: Public can read avatars" stays), written by
-- the picture's own person or record managers.
DROP POLICY IF EXISTS "pm: Authenticated users can upload avatars" ON storage.objects;
DROP POLICY IF EXISTS "pm: Authenticated users can update avatars" ON storage.objects;
DROP POLICY IF EXISTS "pm: Authenticated users can delete avatars" ON storage.objects;
DROP POLICY IF EXISTS "pm: Avatars are added by their person or record managers" ON storage.objects;
CREATE POLICY "pm: Avatars are added by their person or record managers" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'pm-avatars' AND (select pm.current_team_member_id()) IS NOT NULL AND pm.storage_object_allowed(bucket_id, name, 'write'));
DROP POLICY IF EXISTS "pm: Avatars are changed by their person or record managers" ON storage.objects;
CREATE POLICY "pm: Avatars are changed by their person or record managers" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'pm-avatars' AND (select pm.current_team_member_id()) IS NOT NULL AND pm.storage_object_allowed(bucket_id, name, 'delete', owner))
  WITH CHECK (bucket_id = 'pm-avatars' AND (select pm.current_team_member_id()) IS NOT NULL AND pm.storage_object_allowed(bucket_id, name, 'write'));
DROP POLICY IF EXISTS "pm: Avatars are removed by their person or record managers" ON storage.objects;
CREATE POLICY "pm: Avatars are removed by their person or record managers" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'pm-avatars' AND (select pm.current_team_member_id()) IS NOT NULL AND pm.storage_object_allowed(bucket_id, name, 'delete', owner));

-- The pre-2.0 buckets of an upgraded install: read-only fallbacks the server
-- reads (and signs) until 2.1. The app's old member-wide policies go, found
-- by their exact names so another app's buckets are never touched; the file
-- buckets turn private. A fresh install has none of this.
DO $legacy_storage$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname IN (
    'Authenticated users can upload entity files', 'Authenticated users can update entity files',
    'Authenticated users can delete entity files', 'Authenticated users can read entity files')) THEN
    DROP POLICY IF EXISTS "Authenticated users can upload entity files" ON storage.objects;
    DROP POLICY IF EXISTS "Authenticated users can update entity files" ON storage.objects;
    DROP POLICY IF EXISTS "Authenticated users can delete entity files" ON storage.objects;
    DROP POLICY IF EXISTS "Authenticated users can read entity files" ON storage.objects;
    UPDATE storage.buckets SET public = false WHERE id = 'entity-files';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname IN (
    'Authenticated users can upload portal files', 'Authenticated users can update portal files',
    'Authenticated users can delete portal files', 'Public can read portal files')) THEN
    DROP POLICY IF EXISTS "Authenticated users can upload portal files" ON storage.objects;
    DROP POLICY IF EXISTS "Authenticated users can update portal files" ON storage.objects;
    DROP POLICY IF EXISTS "Authenticated users can delete portal files" ON storage.objects;
    DROP POLICY IF EXISTS "Public can read portal files" ON storage.objects;
    UPDATE storage.buckets SET public = false WHERE id = 'portal-files';
  END IF;
  DROP POLICY IF EXISTS "Authenticated users can upload avatars" ON storage.objects;
  DROP POLICY IF EXISTS "Authenticated users can update avatars" ON storage.objects;
  DROP POLICY IF EXISTS "Authenticated users can delete avatars" ON storage.objects;
END
$legacy_storage$;

-- ---------------------------------------------------------------------------
-- 2. task_comments: a comment stays on its task and keeps its author
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS task_comments_update_delete ON pm.task_comments;
DROP POLICY IF EXISTS task_comments_update ON pm.task_comments;
CREATE POLICY task_comments_update ON pm.task_comments FOR UPDATE TO authenticated
  USING (pm.can_access_task(task_id) AND (user_id = pm.current_team_member_id() OR pm.has_permission('tasks.manage_all')))
  WITH CHECK (pm.can_access_task(task_id) AND (user_id = pm.current_team_member_id() OR pm.has_permission('tasks.manage_all')));
DROP POLICY IF EXISTS task_comments_delete ON pm.task_comments;
CREATE POLICY task_comments_delete ON pm.task_comments FOR DELETE TO authenticated
  USING (pm.can_access_task(task_id) AND (user_id = pm.current_team_member_id() OR pm.has_permission('tasks.manage_all')));

-- Browser writes (the authenticated role itself; server code and SECURITY
-- DEFINER functions run as another role): a new comment is the writer's, made
-- now; an edit never moves it to another task, never changes its author and
-- never changes when it was made.
CREATE OR REPLACE FUNCTION pm.task_comments_server_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'A comment stays on its task and keeps its author'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.task_comments_server_fields() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS task_comments_server_fields ON pm.task_comments;
CREATE TRIGGER task_comments_server_fields
  BEFORE INSERT OR UPDATE ON pm.task_comments
  FOR EACH ROW EXECUTE FUNCTION pm.task_comments_server_fields();

-- ---------------------------------------------------------------------------
-- 3. time_entry_tasks: the time entry's own rules
-- ---------------------------------------------------------------------------
-- Read with the entry (the subquery reads project_time_entries under the
-- reader's own row policies). Written by whoever may edit the entry, as
-- time_entries_update allows, and only with tasks of the entry's project.
DROP POLICY IF EXISTS time_entry_tasks_all ON pm.time_entry_tasks;
DROP POLICY IF EXISTS time_entry_tasks_select ON pm.time_entry_tasks;
CREATE POLICY time_entry_tasks_select ON pm.time_entry_tasks FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM pm.project_time_entries entry WHERE entry.id = time_entry_tasks.time_entry_id));
DROP POLICY IF EXISTS time_entry_tasks_insert ON pm.time_entry_tasks;
CREATE POLICY time_entry_tasks_insert ON pm.time_entry_tasks FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM pm.project_time_entries entry
    WHERE entry.id = time_entry_tasks.time_entry_id
      AND pm.can_access_project(entry.project_id)
      AND (pm.has_permission('time.manage_all') OR (
        pm.has_permission('time.manage_own')
        AND entry.member_id = pm.current_team_member_id()
        AND entry.approval_status IN ('draft', 'pending', 'rejected')
      ))
      AND EXISTS (SELECT 1 FROM pm.tasks task WHERE task.id = time_entry_tasks.task_id AND task.project_id = entry.project_id)
  ));
DROP POLICY IF EXISTS time_entry_tasks_update ON pm.time_entry_tasks;
CREATE POLICY time_entry_tasks_update ON pm.time_entry_tasks FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM pm.project_time_entries entry
    WHERE entry.id = time_entry_tasks.time_entry_id
      AND pm.can_access_project(entry.project_id)
      AND (pm.has_permission('time.manage_all') OR (
        pm.has_permission('time.manage_own')
        AND entry.member_id = pm.current_team_member_id()
        AND entry.approval_status IN ('draft', 'pending', 'rejected')
      ))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM pm.project_time_entries entry
    WHERE entry.id = time_entry_tasks.time_entry_id
      AND pm.can_access_project(entry.project_id)
      AND (pm.has_permission('time.manage_all') OR (
        pm.has_permission('time.manage_own')
        AND entry.member_id = pm.current_team_member_id()
        AND entry.approval_status IN ('draft', 'pending', 'rejected')
      ))
      AND EXISTS (SELECT 1 FROM pm.tasks task WHERE task.id = time_entry_tasks.task_id AND task.project_id = entry.project_id)
  ));
DROP POLICY IF EXISTS time_entry_tasks_delete ON pm.time_entry_tasks;
CREATE POLICY time_entry_tasks_delete ON pm.time_entry_tasks FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM pm.project_time_entries entry
    WHERE entry.id = time_entry_tasks.time_entry_id
      AND pm.can_access_project(entry.project_id)
      AND (pm.has_permission('time.manage_all') OR (
        pm.has_permission('time.manage_own')
        AND entry.member_id = pm.current_team_member_id()
        AND entry.approval_status IN ('draft', 'pending', 'rejected')
      ))
  ));

-- ---------------------------------------------------------------------------
-- 4. Manage without View all
-- ---------------------------------------------------------------------------
-- leads.manage acts on the leads the person reaches (can_access_lead), plus
-- the ones they created or hold. It still adds leads. The extra read policy
-- keeps a new lead readable to its maker in the same statement (INSERT ...
-- RETURNING), where can_access_lead cannot see the row yet.
DROP POLICY IF EXISTS leads_manage ON pm.leads;
DROP POLICY IF EXISTS leads_manage_select ON pm.leads;
CREATE POLICY leads_manage_select ON pm.leads FOR SELECT TO authenticated
  USING (pm.has_permission('leads.manage') AND (
    pm.has_permission('leads.read_all')
    OR assigned_to = pm.current_team_member_id()
    OR created_by = pm.current_team_member_id()
  ));
DROP POLICY IF EXISTS leads_insert ON pm.leads;
CREATE POLICY leads_insert ON pm.leads FOR INSERT TO authenticated
  WITH CHECK (pm.has_permission('leads.manage'));
DROP POLICY IF EXISTS leads_update ON pm.leads;
CREATE POLICY leads_update ON pm.leads FOR UPDATE TO authenticated
  USING (pm.has_permission('leads.manage') AND (pm.can_access_lead(id) OR created_by = pm.current_team_member_id()))
  WITH CHECK (pm.has_permission('leads.manage'));
DROP POLICY IF EXISTS leads_delete ON pm.leads;
CREATE POLICY leads_delete ON pm.leads FOR DELETE TO authenticated
  USING (pm.has_permission('leads.manage') AND (pm.can_access_lead(id) OR created_by = pm.current_team_member_id()));

-- contacts.manage acts on the contacts the person reaches (contacts.read_all,
-- or linked to a project they open), plus the ones they created.
DROP POLICY IF EXISTS contacts_manage ON pm.contacts;
DROP POLICY IF EXISTS contacts_manage_select ON pm.contacts;
CREATE POLICY contacts_manage_select ON pm.contacts FOR SELECT TO authenticated
  USING (pm.has_permission('contacts.manage') AND (
    pm.has_permission('contacts.read_all') OR created_by = pm.current_team_member_id()
  ));
DROP POLICY IF EXISTS contacts_insert ON pm.contacts;
CREATE POLICY contacts_insert ON pm.contacts FOR INSERT TO authenticated
  WITH CHECK (pm.has_permission('contacts.manage'));
DROP POLICY IF EXISTS contacts_update ON pm.contacts;
CREATE POLICY contacts_update ON pm.contacts FOR UPDATE TO authenticated
  USING (pm.has_permission('contacts.manage') AND (
    pm.can_access_file_entity('contact', id) OR created_by = pm.current_team_member_id()
  ))
  WITH CHECK (pm.has_permission('contacts.manage'));
DROP POLICY IF EXISTS contacts_delete ON pm.contacts;
CREATE POLICY contacts_delete ON pm.contacts FOR DELETE TO authenticated
  USING (pm.has_permission('contacts.manage') AND (
    pm.can_access_file_entity('contact', id) OR created_by = pm.current_team_member_id()
  ));

-- Linking a contact to a project needs that project.
DROP POLICY IF EXISTS project_contacts_manage ON pm.project_contacts;
CREATE POLICY project_contacts_manage ON pm.project_contacts FOR ALL TO authenticated
  USING (pm.has_permission('contacts.manage') AND pm.can_access_project(project_id))
  WITH CHECK (pm.has_permission('contacts.manage') AND pm.can_access_project(project_id));

-- tasks.manage_all changes the assignees of tasks the person reaches.
DROP POLICY IF EXISTS task_assignees_manage ON pm.task_assignees;
CREATE POLICY task_assignees_manage ON pm.task_assignees FOR ALL TO authenticated
  USING (pm.has_permission('tasks.manage_all') AND pm.can_access_task(task_id))
  WITH CHECK (pm.has_permission('tasks.manage_all') AND pm.can_access_task(task_id));

-- projects has no member write grants: this policy only ever read. It reads
-- the projects the person opens.
DROP POLICY IF EXISTS projects_manage ON pm.projects;
CREATE POLICY projects_manage ON pm.projects FOR ALL TO authenticated
  USING (pm.has_permission('projects.manage') AND pm.can_access_project(id))
  WITH CHECK (pm.has_permission('projects.manage') AND pm.can_access_project(id));

-- ---------------------------------------------------------------------------
-- 5. Personal inboxes: verification is the server's
-- ---------------------------------------------------------------------------
-- Inboxes are made and verified by the server (the settings service and
-- ingestion run as the service role). A browser write never sets
-- verified_at or verification_code, and a browser change of address clears
-- the verification until the new code arrives.
CREATE OR REPLACE FUNCTION pm.inboxes_server_verification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.verified_at := NULL;
    NEW.verification_code := pm.email_inbox_verification_code();
    RETURN NEW;
  END IF;
  NEW.verification_code := OLD.verification_code;
  IF NEW.address IS DISTINCT FROM OLD.address THEN
    NEW.verified_at := NULL;
  ELSE
    NEW.verified_at := OLD.verified_at;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.inboxes_server_verification() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS inboxes_server_verification ON pm.inboxes;
CREATE TRIGGER inboxes_server_verification
  BEFORE INSERT OR UPDATE ON pm.inboxes
  FOR EACH ROW EXECUTE FUNCTION pm.inboxes_server_verification();

-- ---------------------------------------------------------------------------
-- 6. Server-set task columns
-- ---------------------------------------------------------------------------
-- A browser write (the authenticated role itself) never backdates a task,
-- never sets when it was finished outside a status change, never takes or
-- extends a claim (it may release one) and never sets the repeat count.
-- Claims go through pm.claim_task and friends, which run as their owner.
CREATE OR REPLACE FUNCTION pm.tasks_server_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.completed_at := CASE WHEN NEW.status = 'done' THEN now() END;
    NEW.claimed_by := NULL;
    NEW.claimed_at := NULL;
    NEW.claim_expires_at := NULL;
    NEW.claim_assigned := false;
    NEW.occurrences := 1;
    NEW.last_occurred_at := NULL;
    RETURN NEW;
  END IF;
  NEW.created_at := OLD.created_at;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    NEW.completed_at := OLD.completed_at;
  END IF;
  IF NEW.claimed_by IS NOT NULL
     AND (NEW.claimed_by, NEW.claimed_at, NEW.claim_expires_at, NEW.claim_assigned)
       IS DISTINCT FROM (OLD.claimed_by, OLD.claimed_at, OLD.claim_expires_at, OLD.claim_assigned) THEN
    NEW.claimed_by := OLD.claimed_by;
    NEW.claimed_at := OLD.claimed_at;
    NEW.claim_expires_at := OLD.claim_expires_at;
    NEW.claim_assigned := OLD.claim_assigned;
  END IF;
  NEW.occurrences := OLD.occurrences;
  NEW.last_occurred_at := OLD.last_occurred_at;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.tasks_server_fields() FROM PUBLIC, anon, authenticated;

-- Named to run after tasks_before_update, which stamps completed_at on a
-- status change and ends the claim of a finished task.
DROP TRIGGER IF EXISTS tasks_server_fields ON pm.tasks;
CREATE TRIGGER tasks_server_fields
  BEFORE INSERT OR UPDATE ON pm.tasks
  FOR EACH ROW EXECUTE FUNCTION pm.tasks_server_fields();

-- ---------------------------------------------------------------------------
-- 7. Trash: permission before existence
-- ---------------------------------------------------------------------------
-- A member without the right gets the same answer for a record that exists
-- and one that does not (restore_record: see the note inside it).
CREATE OR REPLACE FUNCTION pm.soft_delete_record(p_table text, p_id uuid, p_actor uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  is_service boolean := coalesce(auth.role(), '') = 'service_role';
  actor uuid;
  changed integer;
  found_row boolean;
  before jsonb;
  after jsonb;
BEGIN
  IF NOT p_table = ANY (pm.trash_record_types()) THEN
    RAISE EXCEPTION 'Trash does not handle %', p_table USING ERRCODE = '22023';
  END IF;
  IF NOT is_service AND NOT coalesce(pm.can_trash_record(p_table, p_id), false) THEN
    RAISE EXCEPTION 'You do not have permission to delete this' USING ERRCODE = '42501';
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM pm.%I WHERE id = $1)', p_table) INTO found_row USING p_id;
  IF NOT found_row THEN
    RAISE EXCEPTION 'Record not found' USING ERRCODE = 'P0002';
  END IF;
  actor := CASE WHEN is_service THEN p_actor ELSE pm.current_team_member_id() END;
  EXECUTE format('SELECT to_jsonb(t) FROM pm.%I t WHERE id = $1', p_table) INTO before USING p_id;
  EXECUTE format('UPDATE pm.%I t SET deleted_at = now(), deleted_by = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING to_jsonb(t)', p_table)
    INTO after USING actor, p_id;
  changed := CASE WHEN after IS NULL THEN 0 ELSE 1 END;
  IF changed > 0 AND NOT is_service THEN
    PERFORM pm.audit_trash_change(p_table, p_id, false, before, after);
  END IF;
  RETURN changed > 0;
END;
$$;

CREATE OR REPLACE FUNCTION pm.restore_record(p_table text, p_id uuid, p_actor uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  is_service boolean := coalesce(auth.role(), '') = 'service_role';
  blocker text;
  changed integer;
  found_row boolean;
  before jsonb;
  after jsonb;
BEGIN
  IF NOT p_table = ANY (pm.trash_record_types()) THEN
    RAISE EXCEPTION 'Trash does not handle %', p_table USING ERRCODE = '22023';
  END IF;
  -- A member hears "no permission" for a record that does not exist, as for
  -- one they may not restore. What still blocks a restore (its task or
  -- project in Trash) is said first, so whoever trashed both learns the order.
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM pm.%I WHERE id = $1)', p_table) INTO found_row USING p_id;
  IF NOT found_row THEN
    IF is_service THEN
      RAISE EXCEPTION 'Record not found' USING ERRCODE = 'P0002';
    END IF;
    RAISE EXCEPTION 'You do not have permission to restore this' USING ERRCODE = '42501';
  END IF;
  blocker := pm.trash_restore_blocker(p_table, p_id);
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION '%', blocker USING ERRCODE = '55000';
  END IF;
  IF NOT is_service AND NOT coalesce(pm.can_trash_record(p_table, p_id), false) THEN
    RAISE EXCEPTION 'You do not have permission to restore this' USING ERRCODE = '42501';
  END IF;
  -- Restoring re-runs the record's own rules (an invoice links its hours
  -- and retainer period again); a clash with what happened meanwhile
  -- refuses it, saying why.
  EXECUTE format('SELECT to_jsonb(t) FROM pm.%I t WHERE id = $1', p_table) INTO before USING p_id;
  BEGIN
    EXECUTE format('UPDATE pm.%I t SET deleted_at = NULL, deleted_by = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING to_jsonb(t)', p_table)
      INTO after USING p_id;
    changed := CASE WHEN after IS NULL THEN 0 ELSE 1 END;
  EXCEPTION WHEN raise_exception THEN
    RAISE EXCEPTION 'It cannot come back as it was: %', SQLERRM USING ERRCODE = '55000';
  END;
  IF changed > 0 AND NOT is_service THEN
    PERFORM pm.audit_trash_change(p_table, p_id, true, before, after);
  END IF;
  -- Retainer months that came due while it (or its project) was in Trash
  -- are skipped, as a pause skips them: restoring never back-bills.
  IF changed > 0 AND p_table IN ('projects', 'project_retainers') THEN
    INSERT INTO pm.project_retainer_periods (retainer_id, period_start, period_end, status)
    SELECT due.retainer_id, due.period_start, due.period_end, 'skipped'
    FROM pm.retainer_due_periods_internal(
      CASE WHEN p_table = 'projects' THEN p_id ELSE (after->>'project_id')::uuid END,
      pm.workspace_today()) due
    WHERE (p_table = 'projects' OR due.retainer_id = p_id)
      AND due.bill_date >= ((before->>'deleted_at')::timestamptz AT TIME ZONE pm.workspace_timezone())::date
    ON CONFLICT (retainer_id, period_start) DO NOTHING;
  END IF;
  RETURN changed > 0;
END;
$$;

REVOKE ALL ON FUNCTION pm.soft_delete_record(text, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION pm.soft_delete_record(text, uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION pm.restore_record(text, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION pm.restore_record(text, uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Webhooks: an endpoint never receives what its maker could not read
-- ---------------------------------------------------------------------------
-- An endpoint with project_ids NULL received every project's events, whoever
-- made it. Now an event that touches projects reaches an endpoint only while
-- the endpoint's maker (created_by) reads at least one of those projects
-- (projects.read_all, or projects.read and a member of one). Events that
-- touch no project are unchanged. An endpoint whose maker left the team
-- (created_by NULL) is the workspace's own and is unchanged. A suspended
-- maker reads nothing, so their endpoints stop receiving project events.
CREATE OR REPLACE FUNCTION pm.webhook_maker_reaches(p_maker uuid, p_project_ids uuid[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT p_maker IS NULL
    OR coalesce(cardinality(p_project_ids), 0) = 0
    -- Either channel: an agent's reach is granted on the API channel only (2.0.49), a person's usually on the app.
    OR pm.member_has_permission(p_maker, 'projects.read_all', 'app')
    OR pm.member_has_permission(p_maker, 'projects.read_all', 'api')
    OR ((pm.member_has_permission(p_maker, 'projects.read', 'app') OR pm.member_has_permission(p_maker, 'projects.read', 'api')) AND EXISTS (
      SELECT 1 FROM pm.project_members pmb
      WHERE pmb.member_id = p_maker AND pmb.project_id = ANY (p_project_ids)
    ))
$$;

REVOKE ALL ON FUNCTION pm.webhook_maker_reaches(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.webhook_maker_reaches(uuid, uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION pm.webhook_endpoint_matches(
  p_endpoint pm.webhook_endpoints,
  p_event_type text,
  p_project_ids uuid[],
  p_member_ids uuid[]
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pm
AS $$
  SELECT p_endpoint.is_active
    AND p_event_type = ANY (p_endpoint.events)
    AND (p_endpoint.project_ids IS NULL OR p_endpoint.project_ids && coalesce(p_project_ids, '{}'))
    AND (p_endpoint.member_id IS NULL OR p_endpoint.member_id = ANY (coalesce(p_member_ids, '{}')))
    AND (p_endpoint.assistant_setup_id IS NULL OR EXISTS (
      SELECT 1 FROM pm.team_members a
      WHERE a.id = ANY (coalesce(p_member_ids, '{}'))
        AND a.assistant_setup_id = p_endpoint.assistant_setup_id
        AND a.role = 'agent' AND a.delegate_of IS NOT NULL
    ))
    AND pm.webhook_maker_reaches(p_endpoint.created_by, p_project_ids)
$$;

REVOKE ALL ON FUNCTION pm.webhook_endpoint_matches(pm.webhook_endpoints, text, uuid[], uuid[]) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. Avatars: only a picture link or a path on the app is stored
-- ---------------------------------------------------------------------------
-- The server routes check this (src/lib/schemas/profile.ts); this catches the
-- direct writes (contacts by contacts.manage holders, team_members by an
-- Owner). Checked only when the avatar changes, so a row stored before this
-- (rendered through safeImageUrl, which drops anything unsafe) never blocks
-- an unrelated update.
CREATE OR REPLACE FUNCTION pm.guard_avatar_url()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
DECLARE
  v_new text := CASE WHEN TG_TABLE_NAME = 'contacts' THEN to_jsonb(NEW)->>'avatar_url' ELSE to_jsonb(NEW)->>'avatar' END;
  v_old text := CASE WHEN TG_OP = 'UPDATE' THEN (CASE WHEN TG_TABLE_NAME = 'contacts' THEN to_jsonb(OLD)->>'avatar_url' ELSE to_jsonb(OLD)->>'avatar' END) END;
BEGIN
  IF (TG_OP = 'INSERT' OR v_new IS DISTINCT FROM v_old) AND v_new IS NOT NULL AND v_new <> '' AND NOT (
    length(v_new) <= 2000 AND (
      v_new ~ '^https://[^[:space:][:cntrl:]]+$'
      OR v_new ~ '^http://(localhost|127\.0\.0\.1|\[::1\])([:/][^[:space:][:cntrl:]]*)?$'
      OR (v_new ~ '^/[^/[:space:][:cntrl:]][^[:space:][:cntrl:]]*$' AND strpos(v_new, chr(92)) = 0)
    )
  ) THEN
    RAISE EXCEPTION 'An avatar must be an https picture link or a path on this app' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.guard_avatar_url() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.guard_avatar_url() TO service_role;

DROP TRIGGER IF EXISTS team_members_avatar_guard ON pm.team_members;
CREATE TRIGGER team_members_avatar_guard BEFORE INSERT OR UPDATE OF avatar ON pm.team_members
  FOR EACH ROW EXECUTE FUNCTION pm.guard_avatar_url();
DROP TRIGGER IF EXISTS contacts_avatar_guard ON pm.contacts;
CREATE TRIGGER contacts_avatar_guard BEFORE INSERT OR UPDATE OF avatar_url ON pm.contacts
  FOR EACH ROW EXECUTE FUNCTION pm.guard_avatar_url();

