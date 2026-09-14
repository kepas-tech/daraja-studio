-- Phase 3B fix round 1. people_username_key (001) is UNIQUE but case-sensitive, while login
-- (auth/routes.ts) and the create-person duplicate check (people/routes.ts) both match on
-- lower(username) — without this index 'Owner' and 'owner' could exist as two separate rows,
-- and a login for either username could resolve to the wrong one once last_login_at reorders the
-- heap. Guarded and idempotent, like 007 and 008: running this file again changes nothing.
--
-- No data rewrite: a database that already has case-duplicate usernames fails this migration
-- loudly, which is correct — nothing here should silently merge or rename a real account.
CREATE UNIQUE INDEX IF NOT EXISTS people_username_lower_uniq ON people (lower(username));
