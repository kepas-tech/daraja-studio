export const PERMISSIONS = [
  { key: 'balances.view', label: 'Can see balances', role: 'Balance Query ORG API' },
  { key: 'send.phone', label: 'Can send money to phones', role: 'ORG B2C API Initiator' },
  { key: 'send.pochi', label: 'Can send money to business wallets', role: 'ORG B2C API Initiator' },
  { key: 'pay.paybill', label: 'Can pay paybills', role: 'Business Paybill Org API initiator' },
  { key: 'pay.till', label: 'Can pay tills', role: 'Business Buy Goods Org API initiator' },
  { key: 'float.move', label: 'Can move float from Working to Utility', role: 'Float transfer whitelisting' },
  { key: 'topup.b2c', label: 'Can top up another B2C shortcode', role: 'BusinessPayToBulk ORG API Initiator' },
  { key: 'tax.remit', label: 'Can pay KRA', role: 'Tax Remittance to KRA API' },
  { key: 'lookup.view', label: 'Can look up any payment', role: 'Transaction Status query ORG API' },
  { key: 'reverse.request', label: 'Can reverse payments', role: 'Org Reversals Initiator' },
  { key: 'stk.request', label: 'Can ask for payment', role: 'STK passkey' },
  { key: 'qr.generate', label: 'Can make QR codes', role: null },
  { key: 'invoices.manage', label: 'Can send and cancel invoices', role: 'Bill Manager' },
  { key: 'standing_orders.manage', label: 'Can set up standing orders', role: 'M-Pesa Ratiba' },
  { key: 'express.checkout', label: 'Can run express checkout', role: null },
  { key: 'bonga.redeem', label: 'Can redeem Bonga points', role: null },
  { key: 'money_in.view', label: 'Can see money coming in', role: null },
  { key: 'bulk.send', label: 'Can do bulk sends', role: 'ORG B2C API Initiator' },
  { key: 'send.approve', label: 'Can approve sends others made', role: null },
  { key: 'history.export', label: 'Can export history', role: null },
  { key: 'contacts.manage', label: 'Can keep the contact list', role: null },
  { key: 'businesses.manage', label: 'Can set up businesses and their accounts', role: null },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];
const KEYS = new Set<string>(PERMISSIONS.map((p) => p.key));
export function isPermissionKey(s: string): s is PermissionKey { return KEYS.has(s); }
