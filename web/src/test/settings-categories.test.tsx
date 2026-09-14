import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Settings } from '../pages/Settings';
import { ToastHost } from '../components/Toast';
import { copy } from '../copy/en';

vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
afterEach(() => cleanup());

const slot = { shortcode: null, consumerKey: { saved: false, last4: null }, consumerSecret: { saved: false, last4: null }, credsVerifiedAt: null, passkey: { saved: false, last4: null }, cert: { saved: false, last4: null }, operators: [], ready: { creds: false, operator: false }, b2cApi: { setting: 'auto', detected: null, detectedAt: null } };
const categories = [{ id: 'business', name: 'Business payment', commandId: 'BusinessPayment' }, { id: 'salary', name: 'Salary', commandId: 'SalaryPayment' }];
const view = { mode: 'sandbox', environments: { sandbox: slot, production: slot }, org: { name: 'KEPAS', nominatedNumber: '', notificationPhone: '' }, stkEnabled: false, publicUrl: null, publicVerifiedAt: null, httpsSeen: false, allowlist: [], setupCompletedAt: 'x', sendCategories: categories };

function mount(items = categories) {
  const puts: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    if (url === '/api/settings' && method === 'GET') return new Response(JSON.stringify({ ...view, sendCategories: items }), { status: 200 });
    if (url === '/api/settings/send-categories' && method === 'PUT') { const b = JSON.parse(String(init?.body)); puts.push(b); return new Response(JSON.stringify({ items: b.items }), { status: 200 }); }
    throw new Error(`unexpected ${method} ${url}`);
  }));
  render(<MemoryRouter><ToastHost /><Settings /></MemoryRouter>);
  return puts;
}
const confirm = async () => { fireEvent.change(await screen.findByLabelText(copy.confirm.yourPassword), { target: { value: 'pw' } }); fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm })); };

describe('Settings › Payment categories', () => {
  it('lists each category with its Safaricom kind', async () => {
    mount();
    const row = await screen.findByTestId('category-salary');
    expect(row).toHaveTextContent('Salary');
    expect(row).toHaveTextContent(copy.send.phone.kinds.SalaryPayment!);
  });

  it('adds a category with a chosen Safaricom kind', async () => {
    const puts = mount();
    fireEvent.click(await screen.findByRole('button', { name: copy.settings.categories.add }));
    fireEvent.change(screen.getByLabelText(copy.settings.categories.name), { target: { value: 'Personal use' } });
    fireEvent.click(screen.getByRole('button', { name: copy.questionnaire.next }));
    fireEvent.change(screen.getByLabelText(copy.settings.categories.kind), { target: { value: 'PromotionPayment' } });
    fireEvent.click(screen.getByRole('button', { name: copy.settings.save }));
    await confirm();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect((puts[0] as { items: unknown[] }).items).toEqual([...categories, { name: 'Personal use', commandId: 'PromotionPayment' }]);
  });

  it('edits a name in place and deletes one, but never the last', async () => {
    const puts = mount();
    const row = await screen.findByTestId('category-salary');
    fireEvent.click(within(row).getByRole('button', { name: copy.settings.categories.edit }));
    fireEvent.change(within(row).getByLabelText(copy.settings.categories.name), { target: { value: 'Wages' } });
    fireEvent.click(within(row).getByRole('button', { name: copy.questionnaire.next }));
    fireEvent.click(within(row).getByRole('button', { name: copy.settings.save }));
    await confirm();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect((puts[0] as { items: { name: string }[] }).items.map((c) => c.name)).toEqual(['Business payment', 'Wages']);
    fireEvent.click(within(screen.getByTestId('category-business')).getByRole('button', { name: copy.settings.categories.remove }));
    await confirm();
    await waitFor(() => expect(puts).toHaveLength(2));
    expect((puts[1] as { items: { id: string }[] }).items.map((c) => c.id)).toEqual(['salary']);
    cleanup();
    mount([categories[0]!]);
    const only = await screen.findByTestId('category-business');
    expect(within(only).getByRole('button', { name: copy.settings.categories.remove })).toBeDisabled();
  });
});
