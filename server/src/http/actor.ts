import { HttpError } from '../util/errors.js';
import type { Request } from 'express';

/**
 * The person behind a request, for a column that points at `people`. An API key acts under a
 * person-shaped stand-in whose id is the key's own (http/orgContext.ts), and writing that into a
 * people column breaks its foreign key, so a key's actions are recorded with no person. The key
 * itself is named where the row has room for it (requests.api_key_id, the audit row's after_json).
 */
export function personOf(req: Request): string | null {
  return req.apiKey ? null : req.person!.id;
}

/** For work only a person does (a case file's notes, say): a key is refused, never recorded as one. */
export function personOnly(req: Request): string {
  if (req.apiKey) throw new HttpError(403, 'person_only', 'A person does this, not an API key.');
  return req.person!.id;
}
