import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, afterEach } from 'vitest';
import { RequestCard } from '../components/RequestCard';
import { copy } from '../copy/en';
import type { RequestView } from '../api/types';

afterEach(() => cleanup());

const base: RequestView = { id: 'r1', type: 'b2c', subtype: 'BusinessPayment', status: 'completed', amountCents: 100, currency: 'KES', recipient: { kind: 'phone', value: '254700123456', name: 'Jane Doe' }, direction: 'out', party: { name: 'Jane Doe', number: '254700123456', savedName: null }, remarks: 'rent', category: null, contactName: null, accountReference: null, businessName: null, accountName: null, receipt: 'RI6BZTPXNM', createdAt: '2026-09-06T11:00:00Z', sentAt: '2026-09-06T11:00:01Z', resultAt: '2026-09-06T11:00:05Z', resultSource: 'callback', safaricomSaid: 'The service request is processed successfully.', meaning: 'ok', whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: { id: 'p', displayName: 'Owner' } };

describe('RequestCard', () => {
  it('shows amount, recipient, receipt and the status label', () => {
    render(<MemoryRouter><RequestCard request={base} /></MemoryRouter>);
    expect(screen.getByText('KES 1')).toBeInTheDocument();
    expect(screen.getByText('0700 123 456')).toBeInTheDocument();
    expect(screen.getByText('RI6BZTPXNM')).toBeInTheDocument();
    expect(screen.getByText(copy.request.status.completed)).toBeInTheDocument();
  });
  // Round 3, phase A: one column, two people. The direction says which word is true, the name
  // leads, the number sits under it, and the owner's own label appears only when it differs.
  it('leads with the person, puts the number under them, and says which way the money went', () => {
    render(<MemoryRouter><RequestCard request={base} /></MemoryRouter>);
    expect(screen.getByText(copy.request.to)).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('0700 123 456')).toBeInTheDocument();
    cleanup();
    render(<MemoryRouter><RequestCard request={{ ...base, type: 'c2b', direction: 'in', party: { name: 'Jane Wanjiru', number: '254700123456', savedName: 'Mum' } }} /></MemoryRouter>);
    expect(screen.getByText(copy.request.from)).toBeInTheDocument();
    expect(screen.getByText('Jane Wanjiru')).toBeInTheDocument();
    expect(screen.getByText(copy.request.savedAs('Mum'))).toBeInTheDocument();
  });

  it('shows the three lines on failure and the checked note on unknown', () => {
    const { rerender } = render(<MemoryRouter><RequestCard request={{ ...base, status: 'failed', receipt: null, safaricomSaid: 'The initiator information is invalid.', meaning: 'Bad credential', whatToDo: 'Fix the operator.' }} /></MemoryRouter>);
    expect(screen.getByRole('alert')).toHaveTextContent('The initiator information is invalid.');
    expect(screen.getByRole('alert')).toHaveTextContent('Fix the operator.');
    rerender(<MemoryRouter><RequestCard request={{ ...base, status: 'unknown', receipt: null, safaricomSaid: null, meaning: 'No answer', whatToDo: 'Check the portal', checked: { by: { id: 'p', displayName: 'Owner' }, at: '2026-09-06T12:00:00Z', note: 'Paid, seen in portal' } }} /></MemoryRouter>);
    expect(screen.getByText(copy.request.checkedBy('Owner', 'Paid, seen in portal'))).toBeInTheDocument();
    // W4: once checked, the card must not still promise "Studio will check" — the checked-by
    // line replaces meaning/whatToDo entirely rather than sitting alongside them.
    expect(screen.queryByText('No answer')).not.toBeInTheDocument();
    expect(screen.queryByText('Check the portal')).not.toBeInTheDocument();
  });
});
