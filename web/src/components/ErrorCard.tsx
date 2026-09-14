import { ApiError } from '../api/client';
import { copy } from '../copy/en';
export type Explained = { safaricomSaid: string; meaning: string; whatToDo: string };
function isExplained(e: ApiError | Explained | Error): e is Explained {
  return 'safaricomSaid' in e;
}
export function explainApiError(e: unknown): Error | Explained {
  if (e instanceof ApiError) {
    if (e.code === 'safaricom_rejected') {
      const d = e.details as { safaricomSaid?: unknown; meaning?: unknown; whatToDo?: unknown } | undefined;
      if (d && typeof d.safaricomSaid === 'string' && typeof d.meaning === 'string') {
        // Design decision W4: on a hosted service this third line is the address to whitelist, written by
        // the server (sdk/meaning.ts's whitelistAdvice). Replacing it with the generic sentence
        // would throw away the one thing the tenant has to act on.
        return {
          safaricomSaid: d.safaricomSaid,
          meaning: d.meaning,
          whatToDo: typeof d.whatToDo === 'string' && d.whatToDo ? d.whatToDo : copy.error.tryAgain,
        };
      }
    }
    if (e.code === 'refresh_in_flight') return new Error(copy.balances.inFlight);
    if (e.code === 'lookup_in_flight') return new Error(copy.lookup.inFlight);
    return new Error(e.message);
  }
  return new Error(copy.error.generic);
}
// For a toast, which has room for one line: an Explained three-line error contributes only its
// "Safaricom said" line — the full three-line explanation stays in the page's own ErrorCard,
// where one already exists for that flow.
export function toastText(e: unknown): string {
  const explained = explainApiError(e);
  return isExplained(explained) ? `${copy.error.safaricomSaid}: ${explained.safaricomSaid}` : explained.message;
}
export function ErrorCard({ error }: { error: ApiError | Explained | Error | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="space-y-1 rounded-lg border border-red-300 bg-red-50 p-4 text-sm dark:bg-red-950/30">
      {isExplained(error) ? (<>
        <p><strong>{copy.error.safaricomSaid}:</strong> {error.safaricomSaid}</p>
        <p><strong>{copy.error.meaning}:</strong> {error.meaning}</p>
        <p><strong>{copy.error.whatToDo}:</strong> {error.whatToDo}</p>
      </>) : <p>{error.message || copy.error.generic}</p>}
    </div>
  );
}
