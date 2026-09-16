import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import type { ContactView } from '../api/types';
import { useSession } from '../app/session';
import { Button } from '../components/Button';
import { Card, cardRow } from '../components/Card';
import { ErrorCard, explainApiError, toastText, type Explained } from '../components/ErrorCard';
import { Loading } from '../components/Loading';
import { PageHeader } from '../components/PageHeader';
import { PhoneInput } from '../components/PhoneInput';
import { Questionnaire, type QuestionStep } from '../components/Questionnaire';
import { Segmented } from '../components/Segmented';
import { TextField } from '../components/TextField';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { normalizeKe, phone } from '../format';

type Kind = ContactView['kind'];
const KINDS: Kind[] = ['phone', 'till', 'paybill'];
/** The server checks both again; this only keeps a wrong answer off the wire. */
const SHORTCODE = /^[0-9]{5,7}$/;
const ACCOUNT = /^[A-Za-z0-9]{1,20}$/;

interface Draft { name: string; phone: string; shortcode: string; accountReference: string; note: string }
const blank = (c: ContactView | null): Draft => ({ name: c?.name ?? '', phone: c?.phone ?? '', shortcode: c?.shortcode ?? '', accountReference: c?.accountReference ?? '', note: c?.note ?? '' });

/** The same class string the secondary Button paints: this one is a link to a page, not an action. */
const linkButton = 'inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-page px-4 text-base font-semibold text-ink hover:bg-line/60 hover:no-underline';

/** Add or change one contact, one question per screen like every other form in Studio. */
function ContactForm({ kind, existing, error, onSave, onCancel }: { kind: Kind; existing: ContactView | null; error: Error | Explained | null; onSave: (kind: Kind, draft: Draft, id?: string) => Promise<void>; onCancel: () => void }) {
  const c = copy.contacts;
  const [draft, setDraft] = useState<Draft>(() => blank(existing));
  const shortcode = draft.shortcode.trim();
  const account = draft.accountReference.trim();
  const shortcodeLabel = kind === 'till' ? c.tillNumber : c.paybillNumber;
  const steps: QuestionStep[] = [
    { key: 'name', question: c.name, valid: draft.name.trim().length > 0, render: () => <TextField label={c.name} labelHidden value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus /> },
    kind === 'phone'
      ? { key: 'phone', question: c.phone, valid: normalizeKe(draft.phone) !== null, render: () => <PhoneInput label={c.phone} labelHidden value={draft.phone} onChange={(v) => setDraft({ ...draft, phone: v })} autoFocus /> }
      : {
        key: 'shortcode', question: shortcodeLabel, hint: c.shortcodeHint, valid: SHORTCODE.test(shortcode),
        render: () => <TextField label={shortcodeLabel} labelHidden inputMode="numeric" value={draft.shortcode} maxLength={7} onChange={(e) => setDraft({ ...draft, shortcode: e.target.value })} autoFocus />,
      },
    ...(kind === 'paybill' ? [{
      key: 'account', question: c.accountReference, hint: c.accountReferenceHint, optional: true, empty: account.length === 0,
      valid: account.length === 0 || ACCOUNT.test(account),
      render: () => <TextField label={c.accountReference} labelHidden value={draft.accountReference} maxLength={20} onChange={(e) => setDraft({ ...draft, accountReference: e.target.value })} autoFocus />,
    } as QuestionStep] : []),
    { key: 'note', question: c.note, optional: true, valid: true, empty: draft.note.trim().length === 0, render: () => <TextField label={c.note} labelHidden value={draft.note} maxLength={200} onChange={(e) => setDraft({ ...draft, note: e.target.value })} autoFocus /> },
  ];
  return (
    <div className="space-y-3">
      <Questionnaire intro={existing ? c.editIntro(existing.name) : c.addIntro} doneLabel={c.save} onDone={() => void onSave(kind, draft, existing?.id)} onCancel={onCancel} steps={steps} />
      <ErrorCard error={error} />
    </div>
  );
}

/** The address book: a name and a number to pay, so a repeat payment is a pick and not retyping. */
export function Contacts() {
  const c = copy.contacts;
  const toast = useToast();
  const { person, permissions } = useSession();
  // Reading is open to anyone signed in; a change is the owner's job (design 2026-09-16).
  const mayManage = !!person?.is_owner || permissions.includes('contacts.manage');
  const [items, setItems] = useState<ContactView[] | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [formErr, setFormErr] = useState<Error | Explained | null>(null);
  const [kind, setKind] = useState<Kind>('phone');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setItems((await api.get<{ items: ContactView[] }>('/api/contacts')).items); setErr(null); }
    catch (e) { setErr(explainApiError(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // The kind comes from the open form, not from the tab: a row is only ever edited on its own tab.
  const save = async (forKind: Kind, draft: Draft, id?: string) => {
    setFormErr(null);
    const body = forKind === 'phone'
      ? { kind: forKind, name: draft.name.trim(), phone: draft.phone.trim(), note: draft.note.trim() || undefined }
      : { kind: forKind, name: draft.name.trim(), shortcode: draft.shortcode.trim(), accountReference: forKind === 'paybill' ? draft.accountReference.trim() || undefined : undefined, note: draft.note.trim() || undefined };
    try {
      if (id) await api.put('/api/contacts/' + id, body); else await api.post('/api/contacts', body);
      toast.success(c.saved);
      setAdding(false); setEditing(null);
      await load();
    } catch (e) { setFormErr(explainApiError(e)); }
  };

  // Deleting only retires the row; History keeps the name it was paid under, so no second question is needed.
  const remove = async (x: ContactView) => {
    try { await api.del('/api/contacts/' + x.id); toast.success(c.removed); await load(); }
    catch (e) { toast.error(toastText(e)); }
  };

  const pick = (k: Kind) => { setKind(k); setAdding(false); setEditing(null); setFormErr(null); };
  if (err && !items) return <><PageHeader title={c.title} /><ErrorCard error={err} /></>;
  if (!items) return <Loading />;
  const shown = items.filter((x) => x.kind === kind);

  return (
    <>
      <PageHeader title={c.title}>
        {mayManage && !adding && !editing && <Button onClick={() => { setFormErr(null); setEditing(null); setAdding(true); }}>{c.add}</Button>}
      </PageHeader>
      <p className="mb-4 text-base text-muted">{c.intro}</p>
      <ErrorCard error={err} />
      <div className="mb-4 max-w-md">
        <Segmented name="contact-kind" label={c.tabsLabel} value={kind} options={KINDS.map((k) => ({ value: k, label: c.tabs[k] }))} onChange={pick} />
      </div>
      {kind !== 'phone' && <p className="mb-4 text-sm text-muted">{c.sendNotBuilt}</p>}

      {adding && (
        <div className="mb-6 max-w-xl">
          <ContactForm key={'add-' + kind} kind={kind} existing={null} error={formErr} onSave={save} onCancel={() => { setAdding(false); setFormErr(null); }} />
        </div>
      )}

      {shown.length === 0 && !adding && <p className="mb-4 text-sm text-muted">{c.empty}</p>}
      <Card bodyClassName="p-0">
        <ul>
          {shown.map((x) => (
            <li key={x.id} data-testid={'contact-' + x.id} className={cardRow}>
              {editing === x.id ? (
                <ContactForm key={'edit-' + x.id} kind={x.kind} existing={x} error={formErr} onSave={save} onCancel={() => { setEditing(null); setFormErr(null); }} />
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="flex min-w-0 flex-col">
                    <span className="text-base font-medium">{x.name}</span>
                    <span className="text-sm text-muted">{x.kind === 'phone' ? phone(x.phone) : [x.shortcode, x.accountReference].filter(Boolean).join(' · ')}</span>
                    {x.note && <span className="text-sm text-muted">{x.note}</span>}
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    {x.kind === 'phone' && <Link className={linkButton} to={'/send/phone?contact=' + x.id}>{c.pay}</Link>}
                    {mayManage && (
                      <>
                        <Button variant="secondary" onClick={() => { setAdding(false); setFormErr(null); setEditing(x.id); }}>{c.edit}</Button>
                        <Button variant="danger" onClick={() => void remove(x)}>{c.remove}</Button>
                      </>
                    )}
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {!mayManage && <p className="mt-4 text-sm text-muted">{c.noManage}</p>}
    </>
  );
}
