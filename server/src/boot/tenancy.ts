import type { Db } from '../db/pool.js';
import { withOrg, withSystem } from '../db/pool.js';
import type { Config } from '../config.js';
import { decrypt, decryptForOrg, encrypt, encryptForOrg, randomSecret, sha256, type Keyring } from '../crypto/secrets.js';

export interface TenancyBootResult {
  /** This install's one organisation. */
  orgId: string | null;
  created: boolean;
  secretsHashed: number;
  rowsReencrypted: number;
  /** Carry S1: how many env.<e>.consumerKeyHash rows this pass wrote. */
  consumerKeysHashed: number;
}

interface Deps {
  /** The admin pool. This runs after migrate() and before the application serves anything. */
  db: Db;
  config: Config;
  keyring: Keyring;
}


/**
 * Refuse to persist a re-encrypted secret before it is proven readable. Called before the `UPDATE`
 * that makes the `v1` plaintext unrecoverable (§12.4 is forward-only), so a wrong key — a salt read
 * through the wrong context, an `info` string typo, a rotation race — aborts the boot instead of
 * silently destroying the only readable copy.
 */
function verifyReencryption(orgId: string, key: Buffer, enc: string, plain: string, rows: number): void {
  // A wrong key does not necessarily produce a wrong-but-comparable plaintext: AES-GCM authenticates
  // the ciphertext, so decrypt() itself throws on a bad key. Both outcomes are the same failure here.
  let matches: boolean;
  try {
    matches = decrypt(key, enc) === plain;
  } catch {
    matches = false;
  }
  if (!matches) {
    throw new Error(`re-encryption verification failed for organisation ${orgId} (${rows} rows)`);
  }
}

const CONSUMER_KEY_SETTINGS = ['env.sandbox.consumerKey', 'env.production.consumerKey'] as const;
const UNIQUE_VIOLATION = '23505';

/**
 * Carry S1. `settings/service.ts` has written `env.<e>.consumerKeyHash` beside every saved Daraja
 * key since Phase 3B, and `settings_consumer_key_uniq` is what makes "one organisation per Daraja
 * app" true (spec 4.4). Every key saved *before* that has no hash — which means a stranger signing
 * up could claim the live organisation's own Daraja app as if it were unclaimed. This writes the
 * missing hashes once, at boot, before the service accepts a single request.
 *
 * Idempotent: an organisation that already has a hash for an environment is skipped, and the INSERT
 * itself does nothing on a conflict with its own row. A key some *other* organisation has already
 * claimed raises 23505 on the unique index; that is logged (never the key, never the hash) and
 * skipped, because refusing to boot over a pre-index duplicate would take the service down for a
 * condition only a host admin can resolve.
 */
async function backfillConsumerKeyHashes(db: Db, keyring: Keyring, orgs: { id: string }[]): Promise<number> {
  let hashed = 0;
  for (const org of orgs) {
    await withOrg(org.id, async () => {
      // The org_id predicate is load-bearing on the admin pool, which may bypass row-level
      // security entirely, so it scopes this read rather than merely documenting intent.
      const rows = await db.query<{ key: string; value: string }>(
        `SELECT s.key, s.value FROM settings s
          WHERE s.org_id = $1 AND s.key = ANY($2)
            AND NOT EXISTS (
              SELECT 1 FROM settings h
               WHERE h.org_id = s.org_id AND h.key = replace(s.key, '.consumerKey', '.consumerKeyHash'))`,
        [org.id, CONSUMER_KEY_SETTINGS],
      );
      for (const row of rows) {
        const plain = await decryptForOrg(keyring, row.value);
        const hashKey = row.key.replace('.consumerKey', '.consumerKeyHash');
        try {
          await db.query(
            `INSERT INTO settings(org_id, key, value, encrypted) VALUES ($1, $2, $3, false)
             ON CONFLICT (org_id, key) DO NOTHING`,
            [org.id, hashKey, sha256(plain)],
          );
          hashed++;
        } catch (e) {
          if (e && typeof e === 'object' && (e as { code?: string }).code === UNIQUE_VIOLATION) {
            console.warn(`boot pass: a Daraja app is already claimed by another organisation; not claimed for ${org.id} (${hashKey})`);
            continue;
          }
          throw e;
        }
      }
    });
  }
  return hashed;
}

/**
 * Everything migration 007 could not do in SQL, done once at boot and safe to run again: create
 * organisation #1 on a fresh single-mode install, turn the old install secret into a lookup hash
 * plus a v2 ciphertext, re-encrypt v1 rows under each organisation's own key, and set the single
 * mode fallback. Spec section 2.6.
 */
export async function bootTenancy(deps: Deps): Promise<TenancyBootResult> {
  const { db, config, keyring } = deps;

  // 1. A fresh install. The row is written in the shape migration 007 leaves behind — hash 'unset',
  //    secret packed as v1 — so step 2 finishes it and there is only one code path.
  let created = false;
  {
    const existing = await withSystem(() => db.query<{ id: string }>('SELECT id FROM orgs LIMIT 1'));
    if (existing.length === 0) {
      // A bare ON CONFLICT DO NOTHING (no conflict target) catches a collision on any of the row's
      // unique constraints — slug, callback_secret_hash (both racers write the literal 'unset'), and
      // orgs_single_host — not only slug. Two instances racing a first boot both pass the
      // check above, but only one INSERT wins; the loser sees `created = false` and falls through to
      // the org the winner created, instead of crashing on a raw duplicate-key error.
      const inserted = await withSystem(() =>
        db.query<{ id: string }>(
          `INSERT INTO orgs(slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt)
           VALUES ('org-1', 'My organisation', 'pending', true, 'unset', $1, gen_random_bytes(32))
           ON CONFLICT DO NOTHING RETURNING id`,
          [encrypt(config.secretKey, randomSecret(32))],
        ),
      );
      created = inserted.length > 0;
    }
  }

  // 2. Turn a carried-across install secret into the callback router's lookup hash and a v2 ciphertext.
  const unhashed = await withSystem(() =>
    db.query<{ id: string; callback_secret_enc: string }>(
      `SELECT id, callback_secret_enc FROM orgs WHERE callback_secret_hash = 'unset'`,
    ),
  );
  for (const org of unhashed) {
    let secret: string;
    if (org.callback_secret_enc === 'unset') {
      secret = randomSecret(32); // migration 007 found nothing to carry across
    } else if (org.callback_secret_enc.startsWith('v1:')) {
      secret = decrypt(config.secretKey, org.callback_secret_enc);
    } else {
      // A hand-seeded database. Refusing to boot would strand an install whose callbacks work.
      secret = org.callback_secret_enc;
    }
    const enc = await withOrg(org.id, () => encryptForOrg(keyring, secret));
    verifyReencryption(org.id, await keyring.keyFor(org.id), enc, secret, 1);
    await withSystem(() =>
      db.query('UPDATE orgs SET callback_secret_hash = $2, callback_secret_enc = $3 WHERE id = $1', [
        org.id,
        sha256(secret),
        enc,
      ]),
    );
  }

  // 3. Re-encrypt every v1 row under the owning organisation's key. One transaction per organisation.
  let rowsReencrypted = 0;
  const orgs = await withSystem(() => db.query<{ id: string }>('SELECT id FROM orgs ORDER BY created_at'));
  for (const org of orgs) {
    rowsReencrypted += await withOrg(org.id, async () => {
      // `org_id = $1` is not belt-and-braces: this is the admin pool, and DATABASE_URL's user is a
      // superuser in the bundled Compose file, in CI and in production — so it bypasses row-level
      // security entirely and the context alone would scope nothing. The filter is what keeps this
      // loop honest even if a restore ever left more than one organisation row behind.
      const settingRows = await db.query<{ key: string; value: string }>(
        `SELECT key, value FROM settings WHERE org_id = $1 AND encrypted AND value LIKE 'v1:%'`,
        [org.id],
      );
      const operatorRows = await db.query<{ id: string; credential_enc: string }>(
        `SELECT id, credential_enc FROM operators WHERE org_id = $1 AND credential_enc LIKE 'v1:%'`,
        [org.id],
      );
      if (settingRows.length === 0 && operatorRows.length === 0) return 0;

      const total = settingRows.length + operatorRows.length;
      const orgKey = await keyring.keyFor(org.id);
      const settingsNew: [string, string][] = [];
      for (const r of settingRows) {
        const plain = decrypt(config.secretKey, r.value);
        const enc = await encryptForOrg(keyring, plain);
        verifyReencryption(org.id, orgKey, enc, plain, total);
        settingsNew.push([r.key, enc]);
      }
      const operatorsNew: [string, string][] = [];
      for (const r of operatorRows) {
        const plain = decrypt(config.secretKey, r.credential_enc);
        const enc = await encryptForOrg(keyring, plain);
        verifyReencryption(org.id, orgKey, enc, plain, total);
        operatorsNew.push([r.id, enc]);
      }
      await db.tx(async (c) => {
        for (const [key, value] of settingsNew) {
          await c.query('UPDATE settings SET value = $2 WHERE key = $1 AND org_id = $3', [key, value, org.id]);
        }
        for (const [id, value] of operatorsNew) {
          await c.query('UPDATE operators SET credential_enc = $2 WHERE id = $1 AND org_id = $3', [id, value, org.id]);
        }
      });
      return settingsNew.length + operatorsNew.length;
    });
  }

  // 3b. Carry S1: claim every saved Daraja app for the organisation that holds it.
  const consumerKeysHashed = await backfillConsumerKeyHashes(db, keyring, orgs);

  // 4. Code that never entered a context belongs to this install's organisation. This sets the
  //    fallback of the pool handed in (the admin pool) and the process value the bare
  //    currentOrgId() answers with — the application pool is a different object, so index.ts
  //    repeats the call on it with the orgId returned below.
  const [host] = await withSystem(() => db.query<{ id: string }>('SELECT id FROM orgs WHERE is_host'));
  const orgId = host?.id ?? null;
  // An install whose organisation is not marked as the host (unreachable through 007, but a
  // restore could produce it) would otherwise boot "successfully" scoped to nothing.
  if (!orgId) {
    throw new Error('This install has no organisation marked as the host (is_host); none was found.');
  }
  db.setFallbackOrg(orgId);

  return { orgId, created, secretsHashed: unhashed.length, rowsReencrypted, consumerKeysHashed };
}
