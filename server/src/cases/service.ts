import type { Db } from '../db/pool.js';
import { HttpError } from '../util/errors.js';
import { audit } from '../audit/log.js';

/**
 * Round 3, phase D-5: the case file on a payment that went wrong.
 *
 * A case belongs to one payment. It is opened, what was done is recorded on it, and it is closed
 * with how it ended — and it never moves money. Closing is a statement about the paper, not about
 * the money: a reversal, a refund or a resend stays where it always was, on its own screens.
 */
export interface CaseNoteView { id: string; note: string; at: string; by: { id: string; displayName: string } | null }
export interface CaseView {
  id: string; requestId: string; title: string; status: 'open' | 'closed';
  openedAt: string; openedBy: { id: string; displayName: string } | null;
  closedAt: string | null; closedBy: { id: string; displayName: string } | null;
  outcome: string | null;
  notes: CaseNoteView[];
}
export interface CaseActor { personId: string; ip: string }
export interface CasesService {
  /** The case the payment's page shows: the open one when there is one, else the newest closed. */
  forRequest(requestId: string): Promise<CaseView | null>;
  open(requestId: string, title: string, actor: CaseActor): Promise<CaseView>;
  addNote(caseId: string, note: string, actor: CaseActor): Promise<CaseView>;
  close(caseId: string, outcome: string, actor: CaseActor): Promise<CaseView>;
}

interface CaseRow {
  id: string; request_id: string; title: string; status: 'open' | 'closed';
  opened_at: Date; closed_at: Date | null; outcome: string | null;
  opened_by: string | null; closed_by: string | null;
  opened_by_name: string | null; closed_by_name: string | null;
}

const SELECT = `SELECT c.id, c.request_id, c.title, c.status, c.opened_at, c.closed_at, c.outcome,
       c.opened_by, c.closed_by, ob.display_name AS opened_by_name, cb.display_name AS closed_by_name
  FROM request_cases c
  LEFT JOIN people ob ON ob.id = c.opened_by
  LEFT JOIN people cb ON cb.id = c.closed_by`;

const NOT_FOUND = 'That case does not exist.';
const CLOSED = 'This case is closed. Nothing more can be recorded on it.';

export function createCasesService({ db }: { db: Db }): CasesService {
  const who = (id: string | null, name: string | null) => (id ? { id, displayName: name ?? '' } : null);

  async function notesOf(caseId: string): Promise<CaseNoteView[]> {
    const rows = await db.query<{ id: string; note: string; at: Date; by_person: string | null; by_name: string | null }>(
      `SELECT n.id, n.note, n.at, n.by_person, p.display_name AS by_name
         FROM case_notes n LEFT JOIN people p ON p.id = n.by_person
        WHERE n.case_id = $1 ORDER BY n.at ASC, n.id ASC`,
      [caseId],
    );
    return rows.map((n) => ({ id: n.id, note: n.note, at: n.at.toISOString(), by: who(n.by_person, n.by_name) }));
  }

  async function view(id: string): Promise<CaseView> {
    const [row] = await db.query<CaseRow>(`${SELECT} WHERE c.id = $1`, [id]);
    if (!row) throw new HttpError(404, 'not_found', NOT_FOUND);
    return {
      id: row.id, requestId: row.request_id, title: row.title, status: row.status,
      openedAt: row.opened_at.toISOString(), openedBy: who(row.opened_by, row.opened_by_name),
      closedAt: row.closed_at?.toISOString() ?? null, closedBy: who(row.closed_by, row.closed_by_name),
      outcome: row.outcome,
      notes: await notesOf(row.id),
    };
  }

  async function statusOf(caseId: string): Promise<'open' | 'closed'> {
    const [row] = await db.query<{ status: 'open' | 'closed' }>('SELECT status FROM request_cases WHERE id = $1', [caseId]);
    if (!row) throw new HttpError(404, 'not_found', NOT_FOUND);
    if (row.status !== 'open') throw new HttpError(409, 'closed', CLOSED);
    return row.status;
  }

  return {
    async forRequest(requestId) {
      // The open case first: a payment with a case in hand shows that one, and only once it is
      // closed does the newest closed one take its place.
      const [row] = await db.query<CaseRow>(`${SELECT} WHERE c.request_id = $1 ORDER BY (c.status = 'open') DESC, c.opened_at DESC LIMIT 1`, [requestId]);
      return row ? view(row.id) : null;
    },

    async open(requestId, title, actor) {
      const [req] = await db.query<{ id: string }>('SELECT id FROM requests WHERE id = $1', [requestId]);
      if (!req) throw new HttpError(404, 'not_found', 'That payment does not exist.');
      let id: string;
      try {
        const [row] = await db.query<{ id: string }>('INSERT INTO request_cases(request_id, title, opened_by) VALUES ($1,$2,$3) RETURNING id', [requestId, title, actor.personId]);
        id = row.id;
      } catch (e) {
        // The partial unique index allows exactly one open case per payment; a second one splits
        // the same story in two, so it is refused rather than merged.
        if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'already_open', 'This payment already has an open case.');
        throw e;
      }
      await audit(db, { personId: actor.personId, ip: actor.ip, action: 'case.opened', target: id, after: { requestId, title } });
      return view(id);
    },

    async addNote(caseId, note, actor) {
      await statusOf(caseId);
      const [row] = await db.query<{ id: string }>('INSERT INTO case_notes(case_id, note, by_person) VALUES ($1,$2,$3) RETURNING id', [caseId, note, actor.personId]);
      await audit(db, { personId: actor.personId, ip: actor.ip, action: 'case.noted', target: caseId, after: { noteId: row.id } });
      return view(caseId);
    },

    async close(caseId, outcome, actor) {
      await statusOf(caseId);
      // Gated on the same condition the read used, so two people closing at once leave exactly
      // one closure rather than overwriting each other's outcome.
      const rows = await db.query<{ id: string }>(
        `UPDATE request_cases SET status = 'closed', closed_at = now(), closed_by = $2, outcome = $3
          WHERE id = $1 AND status = 'open' RETURNING id`,
        [caseId, actor.personId, outcome],
      );
      if (!rows[0]) throw new HttpError(409, 'closed', CLOSED);
      await audit(db, { personId: actor.personId, ip: actor.ip, action: 'case.closed', target: caseId, before: { status: 'open' }, after: { status: 'closed', outcome } });
      return view(caseId);
    },
  };
}
