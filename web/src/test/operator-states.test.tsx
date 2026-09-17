import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EnvironmentTab } from '../pages/settings/EnvironmentTab';
import { ToastHost } from '../components/Toast';
import { copy } from '../copy/en';
import type { EnvSlotView, OperatorView } from '../api/types';
import type { StepUp } from '../pages/settings/useStepUp';

/** Feature 8: the operator card says, in the owner's words, whether the operator is working. */

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const DAY = 86_400_000;
const operator = (over: Partial<OperatorView> = {}): OperatorView => ({
  id: 'o1', name: 'APIONE', environment: 'sandbox', status: 'verified', priority: 1,
  rotatedAt: new Date().toISOString(), lastProbeAt: null, lastError: null,
  expiresAt: new Date(Date.now() + 12 * DAY).toISOString(),
  consecutiveFailures: 0, lastFailureAt: null, downSince: null,
  ...over,
});

const slot = (operators: OperatorView[]): EnvSlotView => ({
  shortcode: '174379', shortcodeKind: 'paybill', safaricomName: null,
  consumerKey: { saved: true, last4: '4f2a' }, consumerSecret: { saved: true, last4: null }, credsVerifiedAt: '2026-09-07T07:00:00Z',
  passkey: { saved: true, last4: null }, passkeyProven: true, cert: { saved: true, last4: null },
  operators, ready: { creds: true, operator: operators.some((o) => o.status === 'verified') },
  b2cApi: { setting: 'auto', detected: null, detectedAt: null },
});

const stepUp: StepUp = {
  ask: vi.fn(),
  dialogProps: { open: false, title: '', busy: false, error: null, onConfirm: vi.fn(), onCancel: vi.fn() },
};

function renderTab(operators: OperatorView[]) {
  render(
    <MemoryRouter>
      <ToastHost />
      <EnvironmentTab env="sandbox" slot={slot(operators)} isActiveMode reload={async () => {}} stepUp={stepUp} />
    </MemoryRouter>,
  );
}

describe('Settings › API operator states', () => {
  it('says Active, Standby, DOWN and Switched off, one per operator', () => {
    renderTab([
      operator({ id: 'a', name: 'ACTIVEONE', status: 'verified' }),
      operator({ id: 'b', name: 'STANDBYONE', status: 'pending' }),
      operator({ id: 'c', name: 'DOWNONE', status: 'failed', consecutiveFailures: 2, lastError: 'Safaricom rejected the API operator credential.' }),
      operator({ id: 'd', name: 'OFFONE', status: 'disabled' }),
    ]);

    expect(within(screen.getByTestId('operator-a')).getByText(copy.settings.operatorStatus.verified)).toBeInTheDocument();
    expect(within(screen.getByTestId('operator-b')).getByText(copy.settings.operatorStatus.pending)).toBeInTheDocument();
    expect(within(screen.getByTestId('operator-c')).getByText(copy.settings.operatorStatus.failed)).toBeInTheDocument();
    expect(within(screen.getByTestId('operator-d')).getByText(copy.settings.operatorStatus.disabled)).toBeInTheDocument();
  });

  it('counts the failures that stand and says when the password runs out', () => {
    renderTab([operator({ consecutiveFailures: 1, lastFailureAt: new Date().toISOString() })]);

    expect(screen.getByText(copy.settings.failures(1))).toBeInTheDocument();
    expect(screen.getByText(copy.settings.expiresIn(12))).toBeInTheDocument();
  });

  it('offers Reinstate on a DOWN operator, explains it, and posts to the probe route', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    renderTab([operator({ status: 'failed', consecutiveFailures: 2, downSince: new Date().toISOString(), lastError: 'Safaricom rejected the API operator credential.' })]);

    const card = screen.getByTestId('operator-o1');
    expect(within(card).getByText(copy.settings.downHelp)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: copy.settings.reinstate }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/settings/operators/o1/probe');
    expect(init.method).toBe('POST');
  });

  it('keeps Test again on an operator that is not down, and an expired password says how long ago', () => {
    renderTab([operator({ expiresAt: new Date(Date.now() - 3 * DAY).toISOString() })]);

    expect(screen.getByRole('button', { name: copy.settings.probe })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.settings.reinstate })).not.toBeInTheDocument();
    expect(screen.getByText(copy.settings.expiredAgo(3))).toBeInTheDocument();
  });
});
