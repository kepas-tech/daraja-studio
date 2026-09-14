import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Qr } from '../pages/Qr';
import { Nav } from '../app/Nav';
import { copy } from '../copy/en';
import { answer, next } from './questionnaire';

const state = vi.hoisted(() => ({ allowed: true }));
vi.mock('../app/session', () => ({ useSession: () => ({ person: { is_owner: false }, permissions: state.allowed ? ['qr.generate'] : [] }) }));
const text = copy.qr;
const details = { merchantName: 'Counter shop', shortcode: '600001', environment: 'sandbox' };
const imageUrl = 'data:image/png;base64,iVBORw0KGgo=';
let posts: Record<string, unknown>[];
let refusal: boolean;
let malformed: boolean;
beforeEach(() => {
  state.allowed = true; refusal = false; malformed = false; posts = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== '/api/qr') throw new Error('Unexpected local endpoint');
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; posts.push(body);
      if (refusal) return new Response(JSON.stringify({ error: { code: 'safaricom_rejected', message: 'Refused', details: {
        safaricomSaid: 'Invalid transaction type', meaning: 'The transaction type was refused.', whatToDo: 'Check the payment type.',
      } } }), { status: 502 });
      return new Response(JSON.stringify({ ...details, ...body, imageUrl: malformed ? 'https://untrusted.invalid/image.svg' : imageUrl }));
    }
    return new Response(JSON.stringify(details));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function fill() {
  render(<Qr />);
  await screen.findByText(details.merchantName);
  next();
  answer(text.reference, 'ORDER-QR', { exact: false });
  next();
  fireEvent.change(screen.getByLabelText(text.amount), { target: { value: '125.50' } });
}
async function fillCustomerAmount() {
  render(<Qr />);
  await screen.findByText(details.merchantName);
  fireEvent.click(screen.getByLabelText(text.till));
  next();
  answer(text.reference, 'ORDER-QR', { exact: false });
  fireEvent.click(screen.getByLabelText(text.customerAmount));
}
describe('QR counter page', () => {
  it('creates and downloads a QR for the displayed payee, then clears it when the reference changes', async () => {
    await fill();
    fireEvent.click(screen.getByRole('button', { name: text.generate }));
    expect(await screen.findByRole('img', { name: text.imageAlt })).toHaveAttribute('src', imageUrl);
    expect(posts).toEqual([{ accountReference: 'ORDER-QR', amountCents: 12550, trxCode: 'PB' }]);
    expect(screen.getByRole('link', { name: text.download })).toHaveAttribute('download', 'mpesa-qr.png');
    expect(screen.getByText(text.unpaid)).toBeInTheDocument();
    expect(screen.getByText(text.sandbox)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(text.amount), { target: { value: '99' } });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: text.download })).not.toBeInTheDocument();
  });
  it('lets the customer enter the amount for a Buy Goods code', async () => {
    await fillCustomerAmount();
    fireEvent.click(screen.getByRole('button', { name: text.generate }));
    await screen.findByRole('img');
    expect(posts[0]).toMatchObject({ amountCents: 0, trxCode: 'BG' });
  });
  it('keeps a refusal in three separate paragraphs and offers retry without a stale image', async () => {
    await fill(); refusal = true;
    fireEvent.click(screen.getByRole('button', { name: text.generate }));
    const error = await screen.findByRole('alert');
    expect(error.querySelectorAll('p')).toHaveLength(3);
    expect(error).toHaveTextContent('Invalid transaction type');
    expect(error).toHaveTextContent('The transaction type was refused.');
    expect(error).toHaveTextContent('Check the payment type.');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    refusal = false;
    fireEvent.click(screen.getByRole('button', { name: text.generate }));
    await screen.findByRole('img');
  });
  it('refuses malformed image URLs and removes an image that cannot be decoded', async () => {
    await fill(); malformed = true;
    fireEvent.click(screen.getByRole('button', { name: text.generate }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text.badResponse);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    malformed = false;
    fireEvent.click(screen.getByRole('button', { name: text.generate }));
    fireEvent.error(await screen.findByRole('img'));
    expect(screen.queryByRole('link', { name: text.download })).not.toBeInTheDocument();
  });
  it('does not call the API or show a form without permission', async () => {
    state.allowed = false; render(<Qr />);
    expect(screen.getByRole('alert')).toHaveTextContent(text.noPermission);
    expect(screen.queryByRole('button', { name: text.generate })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('ships the QR menu destination without the Coming soon label', async () => {
    render(<MemoryRouter><Nav /></MemoryRouter>);
    const entry = screen.getByRole('link', { name: /QR codes/ });
    expect(entry).toHaveAttribute('href', '/qr');
    expect(within(entry).queryByText(/coming soon/i)).not.toBeInTheDocument();
    expect(copy.nav.find((v) => v.key === 'qr')?.available).toBe(true);
  });
  it('keeps invalid and double submissions from sending requests', async () => {
    render(<Qr />); await screen.findByText(details.merchantName);
    next();
    expect(screen.getByRole('button', { name: copy.questionnaire.next })).toBeDisabled();
    answer(text.reference, 'ORDER-QR', { exact: false });
    fireEvent.click(screen.getByLabelText(text.customerAmount));
    const button = screen.getByRole('button', { name: text.generate });
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(posts).toHaveLength(1));
  });
});
