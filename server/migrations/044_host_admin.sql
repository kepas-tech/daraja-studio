-- 044: the host organisation's owner is this install's host admin (spec 6.1).
--
-- Migration 008 wrote this rule and could not carry it out. Migrations run before the boot pass, and
-- the boot pass is what creates organisation #1 on a fresh install, so on a real install 008's UPDATE
-- ran against no organisation at all and matched nothing: is_host_admin stayed false for everybody,
-- the host's owner included. (008's own test seeds the organisation before it migrates, which is a
-- state a fresh install never has, so the test passed while the install did not.)
--
-- This is the repair for the installs that ran under it: the owner of the host organisation, where one
-- exists, and nobody else. Two clauses carry "nobody else". The organisation must be the host's, so a
-- person in any other organisation is never touched; and the person must be that organisation's owner,
-- so nobody in the host organisation is touched either. There is one owner per organisation
-- (migration 003), so this changes at most one row.
--
-- Idempotent: the NOT clause makes a second run change nothing. An install with no host organisation
-- matches nothing and is left exactly as it is.
--
-- 007 put FORCE ROW LEVEL SECURITY on people, which applies to the table owner too, and a migration
-- runs with no organisation in context. Announce ourselves as the system so this can see its own row;
-- transaction-local, and migrate() wraps this file in one transaction. Same line, same reason as 008.
SELECT set_config('app.role', 'system', true);

UPDATE people SET is_host_admin = true
 WHERE is_owner AND NOT is_host_admin
   AND org_id = (SELECT id FROM orgs WHERE is_host);
