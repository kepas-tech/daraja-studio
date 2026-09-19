import type { PoolClient } from 'pg';
import { withSystem } from '../db/pool.js';
import { hashPassword } from '../auth/password.js';

/**
 * Writing an organisation's owner, one way, for everybody who has to.
 *
 * There are two places in the studio that make an owner: the setup wizard, for the install's own
 * organisation, and \`orgs.provision\`, which a package uses to stand a tenant's organisation up
 * together with the person who will run it. Both come through here, so the password is hashed in
 * one place, the row is written in one place, and nothing else has to know how an owner is made.
 *
 * The plain password is hashed and dropped: it is never stored, never logged, and never returned
 * from here. A caller that is handing the password to somebody else (a package provisioning a
 * tenant) keeps its own copy and is responsible for showing it once.
 */
export interface OwnerRow {
  id: string;
  username: string;
  display_name: string;
  is_owner: boolean;
  must_change_password: boolean;
  created_at: Date;
}

export interface OwnerInput {
  /** The organisation the owner belongs to. Written explicitly, so the caller's context is not
   *  what decides whose owner this is. */
  orgId: string;
  username: string;
  displayName: string;
  /** The plain password. Hashed here, and never kept. */
  password: string;
  /** True when somebody else chose the password and is handing it over: the first sign-in then
   *  asks for one of the owner's own. */
  mustChangePassword: boolean;
}

/** Write the owner. The caller owns the transaction, and the unique indexes own the rules: one
 *  owner per organisation, and one username across the whole install. */
export async function writeOwner(c: PoolClient, input: OwnerInput): Promise<OwnerRow> {
  const passwordHash = await hashPassword(input.password);
  const { rows } = await c.query<OwnerRow>(
    `INSERT INTO people(org_id, username, display_name, password_hash, is_owner, must_change_password)
     VALUES ($1, $2, $3, $4, true, $5)
     RETURNING id, username, display_name, is_owner, must_change_password, created_at`,
    [input.orgId, input.username, input.displayName, passwordHash, input.mustChangePassword]);
  return rows[0]!;
}

/**
 * Is this username already somebody's, anywhere on the install?
 *
 * A username is unique across every organisation (migration 009), and the people table is scoped
 * to one organisation, so the question can only be asked from outside all of them. Asking it before
 * anything is written is what lets a caller refuse a taken username without leaving a half-made
 * organisation behind; the unique index is still what makes it true under a race.
 */
export async function usernameTaken(c: PoolClient, username: string): Promise<boolean> {
  const rows = await withSystem(() => c.query<{ one: number }>(
    'SELECT 1 AS one FROM people WHERE lower(username) = lower($1) LIMIT 1', [username]));
  return rows.rows.length > 0;
}

/** What a caller is told when the username is gone. One wording, wherever it is said. */
export const USERNAME_TAKEN = 'Somebody on this service already uses that name or address.';

/** A plain username: the studio's own rule, said once. */
export const PLAIN_USERNAME = /^[a-z0-9_.-]{3,32}$/i;
export const USERNAME_SHAPE = 'A username is 3 to 32 letters, numbers, dots, dashes or the underline mark — or an e-mail address.';
