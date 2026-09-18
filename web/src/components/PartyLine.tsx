import { Link } from 'react-router';
import { copy } from '../copy/en';
import { phone } from '../format';
import type { RequestView } from '../api/types';

/** The person one row shows, and the number to show under them (round 3, phase A). */
export interface Party { name: string | null; number: string | null; savedName: string | null }

/**
 * The read layer already names the person by direction. This is only the fallback for a server that
 * predates it, so a page can never show nothing while the two are out of step.
 */
export function partyOf(r: RequestView): Party {
  return r.party ?? {
    name: r.recipient.name ?? r.accountName ?? r.contactName ?? null,
    number: r.recipient.value,
    savedName: r.contactName ?? null,
  };
}

/** What this row calls the person: money in says From, money out says To, and a row that moves no
 * money at all says Name rather than guessing a direction it does not have. */
export function partyWord(r: RequestView): string {
  if (r.direction === 'in') return copy.request.from;
  if (r.direction === 'out') return copy.request.to;
  return r.direction === null ? copy.request.name : copy.request.to;
}

/**
 * One person, named and numbered the same way everywhere: the name leads and the number sits under
 * it. The owner's own label for that number follows when it differs from the name, because a
 * mismatch between what the owner called somebody and what Safaricom says is exactly what a person
 * needs to see. A row with no name yet leads with its number rather than an empty line.
 */
export function PartyLine({ r, to }: { r: RequestView; to?: string }) {
  const p = partyOf(r);
  const under = p.name && p.number ? phone(p.number) : null;
  const body = (
    <>
      <span className="font-medium">{p.name ?? phone(p.number)}</span>
      {under && <span className="block text-sm text-muted">{under}</span>}
      {p.savedName && p.savedName !== p.name && <span className="block text-sm text-muted">{copy.request.savedAs(p.savedName)}</span>}
    </>
  );
  return <span className="block min-w-0">{to ? <Link to={to}>{body}</Link> : body}</span>;
}
