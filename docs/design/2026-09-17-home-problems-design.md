# Something is wrong — design (brief 2, item 2)

Source: `/Users/ADEA/.claude/plans/account-numbers-and-followups.md` section 5.1. Date 2026-09-17,
version 0.30.0.

## The idea in one line

Home says so when something is wrong: one sentence, one link to the page that puts it right, and it
goes away by itself. The owner also sees the line under it, because fixing it is theirs.

## The three states

| State | Read from | Link |
|---|---|---|
| An operator has stopped working | `operators` where `status = 'failed'`, the oldest by `down_since` | Settings, where Reinstate lives |
| Sends are pending and Safaricom has gone quiet | a send in `sent` older than ten minutes, and no row in `callbacks_raw` newer than ten minutes | Waiting, where the stuck rows and Check with Safaricom are |
| The last balance query was refused | the newest `requests` row of type `balance` (not an operator probe) has status `failed` | Settings, where the Daraja app and operator live |

Ten minutes is the quiet window: the sweep resolves most sends in about two minutes, so ten quiet
minutes with something still waiting is worth saying out loud. Both halves matter for the second
state — a quiet hour with nothing pending is just a quiet hour, and a send made a minute ago has not
waited for anything yet.

Nothing is cached and nothing is written: every condition is derived from rows Studio already keeps,
so each clears itself the moment the state does. That is what "disappears by itself" means here;
there is no dismiss button and nothing to acknowledge.

## API — `GET /api/health/problems`

```ts
type ProblemKind = 'operator_down' | 'no_callback' | 'balance_refused';
interface Problem { kind: ProblemKind; detail: { name: string | null; minutes: number | null } | null }
// -> { items: Problem[] }
```

- Any signed-in person may read it: the sentence is for everybody.
- `detail` rides only for the owner. The server withholds it rather than trusting the page to hide
  it, so a viewer's browser never receives the operator's name or how long it has been down.
- The server sends facts, never sentences: every word the owner reads lives in
  `web/src/copy/en.ts`, which is what keeps the copy rule true and the wording reviewable in one
  place. A browser in another language would translate one file.
- No credential, no phone number and no key material is ever part of a problem.

## Web

- Home reads the list with the rest of the page and re-reads on the events it already follows
  (`request.updated`, `balance.updated`, `operator.updated`, and a stream reconnect), so an answer
  arriving or an operator coming back clears the banner without a reload.
- The banner sits above the setup reminders: it is the more urgent of the two, and the setup ones
  are about a studio that has not started working yet.

## Tests

Server (`server/test/problems.test.ts`, real PostgreSQL): nothing at all when everything is fine; an
operator DOWN with the owner's detail and a viewer's `null`; a healthy operator raises nothing;
pending sends with a stale callback raise `no_callback`; a send made a minute ago does not, a fresh
callback clears it, and a stale one brings it back; a refused balance raises `balance_refused` and a
later success clears it; an operator probe is not a refused balance; and a session is required.

Web (`web/src/test/problems.test.tsx`): one sentence and one link per problem, each link checked
inside its own line (two of the three go to Settings); the detail line appears only when the server
sent one; nothing at all when the list is empty.

## Out of scope, and why

- Email or push when a problem appears: the inbox and web push already carry payment news; a
  problem banner is a screen thing, and the plan did not ask for a message.
- A history of problems: the audit log and the Operators page already keep what happened.
