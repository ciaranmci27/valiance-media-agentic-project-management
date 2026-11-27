# Backups and recovery

Your install's data lives in your own Supabase project, so you own backups and recovery. The app protects you from everyday mistakes; Supabase protects you from losing the database. This page says what each one covers and what to set up once.

## What the app already does

- **Nothing a person or agent deletes is gone.** Deleting a project, task, contact, file and most other records moves it to Trash (Settings > Data > Open Trash), where anyone with the right permission can restore it. The database refuses a real `DELETE` on those tables, so a bug or a manipulated agent cannot erase them either.
- **History is kept.** The activity log, agent events and the audit log record who changed what. Settings > Security sets how long the audit log and fast-growing data (webhook deliveries, agent uptime, agent runs, chat text) are kept; billing events always stay.
- **What does get removed on purpose:** inbox email past its retention setting (its files and rows; tasks made from it stay), and data past the limits you chose in Settings > Security. Those are your settings, so check them once.

Trash covers "someone deleted the wrong thing". It does not cover a lost or corrupted database. That is what the steps below are for.

## Set up once

1. **Use a paid Supabase plan.** The free plan has no backups you can restore. Pro and up take a daily backup.
2. **Turn on point-in-time recovery (PITR)** in the Supabase dashboard: Project Settings > Add-ons > Point in time recovery. It lets you restore the database to any moment in the retention window (7, 14 or 28 days), not just last night. For a company running its work here, it is worth the cost.
3. **Back up your files separately.** Database backups do not include files in Supabase Storage (the `pm-*` buckets: task files, avatars, email attachments). If losing them would hurt, copy the buckets on a schedule to storage you control (for example with `rclone` against Supabase's S3-compatible endpoint).
4. **Keep your secrets somewhere safe outside the host.** `APP_ENCRYPTION_KEY` seals bot tokens and other secrets in the database. Without it, a restored database cannot open them. Store it, and the other values in `.env.local`, in your password manager.
5. **Write down who can restore.** Restoring is done by an owner of the Supabase project, not from inside the app.

## Check it works

Do this once after setup, then every few months:

1. In Supabase, open Database > Backups and confirm recent backups are listed (and PITR shows its window, if on).
2. Restore to a **new** Supabase project, never over production. Supabase can restore a backup into a new project.
3. Point a copy of the app at it (demo or local, never your live domain) and sign in. Spot-check a recent project, a task changed today and a file.
4. Delete the test project when done.

A quick sign from the database itself that WAL archiving (what PITR uses) is running, read only:

```sql
SELECT archived_count, last_archived_time, failed_count, last_failed_time FROM pg_stat_archiver;
```

`last_archived_time` should be within a few minutes of now.

## When something goes wrong

| What happened | Do this |
|---|---|
| Someone deleted records | Restore them from Settings > Data > Open Trash. No downtime, nothing else changes. |
| An agent or person changed many records wrongly | Find the window in the activity and audit logs. Fix a few by hand; for many, restore a PITR copy into a new project and copy the right rows back. |
| The database is lost or corrupted | Restore with PITR (or the latest daily backup) in Supabase. Confirm `APP_ENCRYPTION_KEY` and the other environment values still match, redeploy, sign in and spot-check. |
| Files are missing | Restore them from your own bucket copies (step 3 above). The app links files by path, so files put back at the same path work again. |
| A bad migration | Migrations are additive and safe to run twice, so the usual fix is a newer release. If data was damaged, restore with PITR to just before the migration ran. |

Restoring the whole database rolls back everything after that moment: tasks, time entries, chat, invoices. Prefer Trash or copying rows back from a restored copy when only part of the data is wrong.
