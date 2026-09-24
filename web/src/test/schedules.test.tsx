import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ScheduleForm } from '../pages/schedules/ScheduleForm';
import { ScheduleDetail } from '../pages/schedules/ScheduleDetail';
import { ScheduleLine } from '../components/ScheduleLine';
import { copy } from '../copy/en';

class FakeEventSource {
  listeners: Record<string, EventListener[]> = {};
  onopen: (() => void) | null = null;
  addEventListener(type: string, cb: EventListener) { (this.listeners[type] ??= []).push(cb); }
  close() {}
}
vi.stubGlobal('EventSource', FakeEventSource);
afterEach(() => cleanup());

const c = copy.schedules;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const contacts = [
  { id: 'c1', kind: 'phone', name: 'Jane Wanjiru', phone: '254700123456', shortcode: null, accountReference: null, note: null, createdAt: '' },
  { id: 'c2', kind: 'paybill', name: 'KPLC', phone: null, shortcode: '888880', accountReference: 'METER42', note: null, createdAt: '' },
];
const schedule = {
  id: 's1', name: 'Monthly salaries', state: 'active', every: 'monthly', weekday: 0, dayOfMonth: 30, hour: 9, weekendRule: 'on_day', phoneCommand: 'SalaryPayment',
  startOn: '2026-09-25', endOn: null, words: 'every month on the 30th at 9am, or the last day of a shorter month', totalCents: 1_500_00,
  lines: [{ id: 'l1', contactId: 'c1', name: 'Jane Wanjiru', kind: 'phone', destination: '254700123456', accountReference: null, amountCents: 1_500_00, note: null, gone: false }],
  nextPayOn: '2026-09-30', upcoming: ['2026-09-30', '2026-10-30', '2026-11-30'], consentedBy: 'Owner', consentedAt: '2026-09-24T10:00:00Z', createdAt: '2026-09-24T10:00:00Z', lastRun: null,
};

describe('scheduled payments, on screen', () => {
  it('asks who, how much and how often, then shows the warning, and only saves once it is accepted and confirmed', async () => {
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'GET /api/contacts') return json({ items: contacts });
      if (key === 'GET /api/settings') return json({ approvalThresholdCents: 0 });
      if (key === 'POST /api/schedules/preview') return json({ words: schedule.words, payDates: schedule.upcoming });
      if (key === 'POST /api/schedules') { posted = JSON.parse(String(init?.body)); return json(schedule, 201); }
      throw new Error('unexpected ' + key);
    }));
    render(<MemoryRouter initialEntries={['/schedules/new']}><Routes><Route path="/schedules/new" element={<ScheduleForm />} /><Route path="/schedules/:id" element={<p>landed</p>} /></Routes></MemoryRouter>);
    await screen.findByText(c.form.step1);
    const next = () => screen.getByRole('button', { name: c.form.next });
    expect(next()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(c.form.name), { target: { value: 'Monthly salaries' } });
    await waitFor(() => expect(within(screen.getByLabelText(c.form.payee)).getAllByRole('option')).toHaveLength(3));
    fireEvent.change(screen.getByLabelText(c.form.payee), { target: { value: 'c1' } });
    // Below what M-Pesa sends to a phone: said, and Next stays off.
    fireEvent.change(screen.getByLabelText(c.form.amount, { exact: false }), { target: { value: '5' } });
    expect(screen.getByText(c.form.phoneMin)).toBeInTheDocument();
    expect(next()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(c.form.amount, { exact: false }), { target: { value: '1500' } });
    fireEvent.click(next());
    await screen.findByText(c.form.step2);
    fireEvent.click(next());

    const warning = await screen.findByTestId('schedule-warning');
    await waitFor(() => expect(warning).toHaveTextContent(c.form.warning('KES 1,500', 1, schedule.words)));
    const agree = screen.getByRole('button', { name: c.form.save });
    expect(agree).toBeDisabled();
    fireEvent.click(screen.getByLabelText(c.form.accept));
    fireEvent.click(agree);
    fireEvent.change(await screen.findByLabelText(copy.confirm.yourPassword), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await screen.findByText('landed');
    expect(posted).toMatchObject({ name: 'Monthly salaries', every: 'monthly', dayOfMonth: 30, hour: 9, accepted: true, password: 'pw', lines: [{ contactId: 'c1', amountCents: 150000 }] });
  });

  it('shows the standing line on Home with its actions, and nothing when no schedule is on', async () => {
    let paused = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'GET /api/schedules/summary') return json(paused ? { active: 0, paused: 1, next: null } : { active: 1, paused: 0, next: { id: 's1', name: 'Monthly salaries', totalCents: 312_000_00, people: 14, payOn: '2026-09-30' } });
      if (key === 'POST /api/schedules/s1/pause') { paused = true; return json(schedule); }
      throw new Error('unexpected ' + key);
    }));
    render(<MemoryRouter><ScheduleLine /></MemoryRouter>);
    const line = await screen.findByTestId('home-schedules');
    expect(line).toHaveTextContent('1 payment schedule is on. Next: Monthly salaries, KES 312,000, on');
    expect(within(line).getByRole('link', { name: c.home.seeAll })).toHaveAttribute('href', '/schedules');
    expect(within(line).getByRole('link', { name: c.home.stop })).toHaveAttribute('href', '/schedules/s1');
    fireEvent.click(within(line).getByRole('button', { name: c.home.pause }));
    await waitFor(() => expect(screen.getByTestId('home-schedules')).toHaveTextContent(c.home.paused(1)));
    cleanup();
    vi.stubGlobal('fetch', vi.fn(async () => json({ active: 0, paused: 0, next: null })));
    render(<MemoryRouter><ScheduleLine /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByTestId('home-schedules')).toBeNull());
  });

  it('stops a schedule only with its name typed back and the password', async () => {
    let stopped: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'GET /api/schedules/s1') return json(schedule);
      if (key === 'GET /api/schedules/s1/runs') return json({ items: [] });
      if (key === 'POST /api/schedules/s1/stop') { stopped = JSON.parse(String(init?.body)); return json({ ...schedule, state: 'stopped', upcoming: [] }); }
      throw new Error('unexpected ' + key);
    }));
    render(<MemoryRouter initialEntries={['/schedules/s1']}><Routes><Route path="/schedules/:id" element={<ScheduleDetail />} /></Routes></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: c.detail.stop }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(copy.confirm.yourPassword), { target: { value: 'pw' } });
    const confirm = within(dialog).getByRole('button', { name: copy.confirm.confirm });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(c.detail.stopBody), { target: { value: 'Monthly salaries' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(stopped).toMatchObject({ name: 'Monthly salaries', password: 'pw' }));
  });
});
