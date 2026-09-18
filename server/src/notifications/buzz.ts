import type { Db } from '../db/pool.js';
import { currentOrgId } from '../db/pool.js';
import type { EventHub } from '../events/hub.js';
import type { Classified, NotificationCategory } from './classify.js';
import type { PushService } from '../push/service.js';

/**
 * Round 3, phase D-8: an unread critical alert keeps making itself known.
 *
 * The inbox row already exists and the bell already counts it; what was missing is the second and
 * third reminder. Every ten minutes the scheduler asks for unread criticals that are due, and each
 * one is published to every open Studio tab (which buzzes) and pushed to every device with "Still
 * unread" in front of it. Reading the alert removes it from the query, which is what stops it.
 *
 * The cap is deliberate: an alert nobody has read for two hours has been seen by somebody, and a
 * phone that buzzes all night is a phone whose owner turns notifications off.
 */
export const MAX_BUZZ = 8;
export const BUZZ_EVERY_MINUTES = 15;

export interface Buzzed { id: string; title: string; count: number; times: number; exhausted: boolean }
export interface CriticalBuzzer {
  /** One pass over this organisation's unread criticals. Returns what it reminded about. */
  buzzOnce(): Promise<Buzzed[]>;
}

interface BuzzRow {
  id: string; category: string; type: string; title: string; body: string;
  data: Record<string, unknown>; count: number; buzz_count: number;
}

export function createCriticalBuzzer(deps: { db: Db; events: EventHub; push?: PushService }): CriticalBuzzer {
  return {
    async buzzOnce() {
      const rows = await deps.db.query<BuzzRow>(
        `SELECT id, category, type, title, body, data, count, buzz_count
           FROM notifications
          WHERE read_at IS NULL AND severity = 'critical' AND buzz_count < $1
            AND (last_buzzed_at IS NULL OR last_buzzed_at < now() - ($2 || ' minutes')::interval)
          ORDER BY created_at ASC
          LIMIT 50`,
        [MAX_BUZZ, BUZZ_EVERY_MINUTES],
      );
      const org = currentOrgId();
      const buzzed: Buzzed[] = [];
      for (const n of rows) {
        // Stamped before the message goes out: a push that fails must not make the same alert buzz
        // again on the next tick, which would turn a broken device into a storm.
        await deps.db.query('UPDATE notifications SET last_buzzed_at = now(), buzz_count = buzz_count + 1 WHERE id = $1', [n.id]);
        const times = n.buzz_count + 1;
        const exhausted = times >= MAX_BUZZ;
        await deps.events.publish('notification.buzz', { id: n.id, count: n.count, times, exhausted }, org ?? undefined);
        if (deps.push?.configured()) {
          const message: Classified = {
            severity: 'critical',
            category: n.category as NotificationCategory,
            type: 'notification.buzz',
            title: 'Still unread: ' + n.title,
            body: n.body,
            data: n.data ?? {},
            // A fresh tag per reminder on purpose: the device must show this one rather than
            // replace the banner it already showed.
            dedupeKey: 'buzz:' + n.id + ':' + times,
          };
          await deps.push.notify(message);
        }
        buzzed.push({ id: n.id, title: n.title, count: n.count, times, exhausted });
      }
      return buzzed;
    },
  };
}
