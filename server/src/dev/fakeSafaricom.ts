/**
 * In-process stand-in for Daraja, used by tests and by `STUDIO_FAKE_SAFARICOM=1` for local demos.
 * It answers the SDK's HTTP calls (through `fetchImpl`) and posts result callbacks to the app
 * the way Safaricom would, with fixture bodies shaped like real payloads (values scrubbed).
 * Never moves money. Never loaded in production (config refuses the flag).
 */
export interface FakeSafaricom {
  fetchImpl: typeof fetch;
  calls: { path: string; body: Record<string, unknown> }[];
  completes(): void;
  losesCallback(): void;
  disagrees(): void;
  duplicatesCallback(): void;
  neverAnswers(): void;
  rejectsSync(code: string, desc: string): void;
  /**
   * The provider accepted the request — the prompt exists and its result is still posted — but this
   * server never saw the answer: the response is a 5xx, as a dropped connection or an overloaded
   * gateway leaves it. The synchronous outcome is unknown, which is not the same as a refusal
   * (review correction W1-R2-B). Persists across calls; cleared by `reset()`.
   */
  losesSync(): void;
  credentialError(): void;
  /** The v3 B2C endpoint always answers 403.002.1001 (studio's v1 fallback); v1 behaves normally.
   * Persists across calls, unlike `rejectsSync` — cleared by `reset()`. */
  refusesV3(): void;
  /**
   * What Query Organization Info (`/sfcverify/v1/query/info`) answers for any shortcode. `null`
   * makes the lookup fail the transport way — a non-2xx response — the way the sandbox does; spec
   * 4.3 says it does not answer reliably. `false` answers 200 with a genuine "not found" business
   * response (`ResponseMessage: 'Invalid Identifier'`, no organisation name) — the real production
   * case, distinct from a transport failure. Persists across calls; cleared by `reset()`.
   */
  knowsShortcodeAs(name: string | null | false): void;
  /** A customer pays the paybill. Posts the confirmation to the registered address unless `deliver` is false (a lost one, for the pull check to find). Returns the receipt. */
  customerPays(p: { amount: number; phone: string; account: string; receipt?: string; deliver?: boolean }): Promise<string>;
  /** A customer pays a Bill Manager invoice: posts the payment push to the opt-in's callback address. Returns the transaction id. */
  customerPaysInvoice(p: { account: string; amount: number; phone?: string; transactionId?: string }): Promise<string>;
  /**
   * The instant the fake reports as the payment's `TransactionDate` (Daraja sends East Africa Time
   * without a zone). `null` restores the default, twenty minutes before the callback is posted, so
   * a test asserts against a controlled instant instead of a hardcoded date that decays.
   */
  dateAt(at: Date | null): void;
  reset(): void;
  settle(): Promise<void>;
}

type Scenario = 'completes' | 'losesCallback' | 'disagrees' | 'duplicatesCallback' | 'neverAnswers' | 'credentialError';

const OK_DESC = 'The service request is processed successfully.';
const ACCEPTED = 'Accept the service request successfully.';
const BALANCE = 'Working Account|KES|14.00|14.00|0.00|0.00&Utility Account|KES|34392.00|34392.00|0.00|0.00&Charges Paid Account|KES|0.00|0.00|0.00|0.00';

export interface FakeSafaricomOptions {
  post: (path: string, body: unknown) => Promise<void>;
  delayMs?: number;
  /**
   * Deliver the STK result callback *before* answering the push request (review correction B04).
   * Real callbacks can beat the push response back to the server, and the fake has to be able to
   * reproduce that ordering deterministically rather than by timing.
   */
  callbackBeforeAck?: boolean;
}

export function createFakeSafaricom(opts: FakeSafaricomOptions): FakeSafaricom {
  const delayMs = opts.delayMs ?? 0;
  let scenario: Scenario = 'completes';
  let sync: { code: string; desc: string } | null = null;
  let syncLost = false;
  let v3Refused = false;
  let orgInfoName: string | null | false = 'ACME TRADERS';
  let fixedDate: Date | null = null;
  let n = 0;
  let utility = 34392;
  // A plain FIFO queue, drained only by an explicit `settle()` — never by the timer itself. A
  // real `setTimeout`, even at 0ms, fires independently of test sequencing (the callback for an
  // earlier call can land mid-await of a later one), which would make scenarios that need one
  // result to land strictly before another (the disagreement scenario, matching a real-world
  // race between a manual check and an in-flight callback) nondeterministic. `settle()` drains
  // strictly in the order results were scheduled, so ordering is always call order, never timing.
  // `delayMs` still fires a real timer for the local demo (`STUDIO_FAKE_SAFARICOM=1`), where
  // nothing ever calls `settle()` and a result must post on its own.
  const queue: (() => Promise<void>)[] = [];
  // Keyed by OriginatorConversationID. `phone` is a B2C-only detail: a reversal's entry has none.
  const sent = new Map<string, { receipt: string; amount: number; phone?: number }>();
  const stk = new Map<string, { receipt: string; amount: number; phone: number }>();     // by CheckoutRequestID
  let c2bConfirmUrl: string | null = null;
  let billManagerUrl: string | null = null;
  const paid: { receipt: string; amount: number; phone: string; account: string; at: Date }[] = [];
  const calls: FakeSafaricom['calls'] = [];

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const pathOf = (url: string) => { try { return new URL(url).pathname; } catch { return url; } };
  const later = (fn: () => Promise<void>) => {
    queue.push(fn);
    if (delayMs > 0) {
      setTimeout(() => {
        const i = queue.indexOf(fn);
        if (i !== -1) { queue.splice(i, 1); void fn().catch(() => {}); }
      }, delayMs);
    }
  };
  const param = (Key: string, Value: unknown) => ({ Key, Value });
  /**
   * Daraja's STK `TransactionDate`: the compact `YYYYMMDDHHmmss` form in East Africa Time. The
   * default is twenty minutes before the callback, which keeps every assertion relative to the
   * moment the test runs instead of decaying against a fixed calendar date.
   */
  function transactionDateValue(): number {
    const at = new Date((fixedDate ?? new Date(Date.now() - 20 * 60_000)).getTime() + 3 * 3_600_000);
    const pad = (v: number) => String(v).padStart(2, '0');
    return Number(`${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`);
  }

  function b2cResult(oc: string, conv: string, ok: boolean, receipt: string, amount: number, phone: number, failCode = 2001, failDesc = 'The initiator information is invalid.') {
    return { Result: {
      ResultType: 0, ResultCode: ok ? 0 : failCode, ResultDesc: ok ? OK_DESC : failDesc,
      OriginatorConversationID: oc, ConversationID: conv, TransactionID: ok ? receipt : '',
      ...(ok ? { ResultParameters: { ResultParameter: [
        param('TransactionAmount', amount), param('TransactionReceipt', receipt), param('B2CRecipientIsRegisteredCustomer', 'Y'),
        param('B2CChargesPaidAccountAvailableFunds', 0), param('ReceiverPartyPublicName', `${phone} - Jane Doe`),
        param('TransactionCompletedDateTime', '06.09.2026 14:20:00'), param('B2CUtilityAccountAvailableFunds', utility), param('B2CWorkingAccountAvailableFunds', 14),
      ] } } : {}),
      ReferenceData: { ReferenceItem: { Key: 'QueueTimeoutURL', Value: 'https://studio.example/cb/x/b2c' } },
    } };
  }
  function statusResult(queryOc: string, conv: string, transactionStatus: string, receipt: string, amount: number) {
    return { Result: {
      ResultType: 0, ResultCode: 0, ResultDesc: OK_DESC, OriginatorConversationID: queryOc, ConversationID: conv, TransactionID: receipt,
      ResultParameters: { ResultParameter: [
        param('DebitPartyName', '600999 - ACME'), param('CreditPartyName', '254700123456 - Jane Doe'), param('OriginatorConversationID', queryOc),
        param('InitiatedTime', 20260906142000), param('DebitAccountType', 'Utility Account'), param('DebitPartyCharges', ''), param('TransactionReason', ''),
        param('ReasonType', 'Business Payment to Customer via API'), param('TransactionStatus', transactionStatus), param('FinalisedTime', 20260906142002),
        param('Amount', amount), param('ConversationID', conv), param('ReceiptNo', receipt),
      ] },
    } };
  }
  function balanceResult(oc: string, conv: string, ok = true) {
    return { Result: { ResultType: 0, ResultCode: ok ? 0 : 2001, ResultDesc: ok ? OK_DESC : 'The initiator information is invalid.',
      OriginatorConversationID: oc, ConversationID: conv, TransactionID: ok ? 'X' : '',
      ...(ok ? { ResultParameters: { ResultParameter: [param('AccountBalance', BALANCE)] } } : {}) } };
  }

  /** The reversal result repeats the B2C envelope; only the endpoint it answers differs. */
  function reversalResult(oc: string, conv: string, ok: boolean, receipt: string, amount: number, failCode = 2001, failDesc = 'The initiator information is invalid.') {
    return { Result: {
      ResultType: 0, ResultCode: ok ? 0 : failCode, ResultDesc: ok ? OK_DESC : failDesc,
      OriginatorConversationID: oc, ConversationID: conv, TransactionID: ok ? receipt : '',
      ...(ok ? { ResultParameters: { ResultParameter: [
        param('TransactionAmount', amount), param('TransactionReceipt', receipt),
        param('ReceiverPartyPublicName', '254700123456 - Jane Doe'),
        param('TransactionCompletedDateTime', '06.09.2026 14:20:00'),
        param('B2CUtilityAccountAvailableFunds', utility), param('B2CWorkingAccountAvailableFunds', 14),
      ] } } : {}),
    } };
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = pathOf(String(input));
    if (path.includes('/oauth/')) return json({ access_token: 'fake-token', expires_in: 3599 });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path, body });
    n += 1;
    const conv = `AG_fake_${n}`;
    const resultPath = pathOf(String(body.ResultURL ?? ''));
    // Matched on the unique `stkpush` segment: the guard's direct-HTTP rule keeps the full
    // Safaricom path out of every file but sdk/oauthCheck.ts, and this segment is enough here.
    // The synchronous status query shares that segment and is checked first.
    const isStkQuery = path.includes('stkpushquery');
    const isStk = !isStkQuery && path.includes('/stkpush/');
    const isReversal = path.endsWith('/reversal/v1/request');
    const isMoneyStatusOrBalance = path.endsWith('/b2c/v3/paymentrequest') || path.endsWith('/b2c/v1/paymentrequest')
      || isReversal || path.endsWith('/transactionstatus/v1/query') || path.endsWith('/accountbalance/v1/query') || isStk || isStkQuery
      // Money in's one-time registration can be refused too (a wrong shortcode, an unregistered app).
      || path.endsWith('/registerurl');

    // Decision 2: a synchronous rejection answers the NEXT money/status/balance call, whichever
    // endpoint it lands on, with the Daraja error envelope the SDK actually parses on a non-2xx
    // response — then disarms, so only that one call is rejected.
    if (sync && isMoneyStatusOrBalance) {
      const { code, desc } = sync;
      sync = null;
      return json({ requestId: `fake-${n}`, errorCode: code, errorMessage: desc }, 400);
    }

    if (isReversal) {
      const receipt = String(body.TransactionID ?? '');
      const amount = Number(body.Amount);
      // The reversal API takes no OriginatorConversationID from the caller, so the id the result
      // carries is Safaricom's own — the same shape a v1 B2C send gets. The sweep later asks about a
      // stuck reversal by that same id, so the one status branch answers for both, and the shared
      // map is what makes that work.
      const oc = `fake-rev-${n}`;
      sent.set(oc, { receipt, amount });
      if (scenario !== 'losesCallback' && scenario !== 'neverAnswers') {
        const ok = scenario !== 'credentialError';
        if (ok) utility += amount;
        const post = () => opts.post(resultPath, ok
          ? reversalResult(oc, conv, true, receipt, amount)
          : reversalResult(oc, conv, false, receipt, amount, 8006, 'Security credential locked.'));
        later(post);
        if (scenario === 'duplicatesCallback') later(post);
      }
      return json({ ConversationID: conv, OriginatorConversationID: oc, ResponseCode: '0', ResponseDescription: ACCEPTED });
    }

    if (path.endsWith('/b2c/v3/paymentrequest') || path.endsWith('/b2c/v1/paymentrequest')) {
      if (v3Refused && path.endsWith('/b2c/v3/paymentrequest')) {
        return json({ requestId: `fake-${n}`, errorCode: '403.002.1001', errorMessage: 'You are not authorized to initiate this transaction' }, 403);
      }
      const oc = String(body.OriginatorConversationID ?? `fake-oc-${n}`);
      const amount = Number(body.Amount);
      const phone = Number(body.PartyB);
      const receipt = `RI${String(n).padStart(8, '0')}`;
      sent.set(oc, { receipt, amount, phone });
      if (scenario !== 'losesCallback' && scenario !== 'neverAnswers') {
        const ok = scenario !== 'credentialError';
        if (ok) utility -= amount;
        const post = () => opts.post(resultPath, ok
          ? b2cResult(oc, conv, true, receipt, amount, phone)
          : b2cResult(oc, conv, false, receipt, amount, phone, 8006, 'Security credential locked.'));
        later(post);
        if (scenario === 'duplicatesCallback') later(post);
      }
      return json({ ConversationID: conv, OriginatorConversationID: oc, ResponseCode: '0', ResponseDescription: ACCEPTED });
    }

    if (isStkQuery) {
      const checkoutId = String(body.CheckoutRequestID ?? '');
      const known = stk.get(checkoutId);
      const code = known ? (scenario === 'disagrees' ? '1032' : '0') : '1037';
      const desc = code === '0' ? OK_DESC : code === '1032' ? 'Request cancelled by user' : 'The transaction is being processed';
      return json({ MerchantRequestID: known ? 'MR_query' : '', CheckoutRequestID: checkoutId,
        ResponseCode: '0', ResponseDescription: ACCEPTED, ResultCode: code, ResultDesc: desc });
    }

    if (isStk) {
      const checkoutId = `ws_CO_${n}`;
      const merchantId = `MR_${n}`;
      const amount = Number(body.Amount);
      const phone = Number(body.PartyA);
      const receipt = `RI${String(n).padStart(8, '0')}`;
      stk.set(checkoutId, { receipt, amount, phone });
      if (scenario !== 'losesCallback' && scenario !== 'neverAnswers') {
        const ok = scenario !== 'credentialError';
        const resultPath = pathOf(String(body.CallBackURL ?? ''));
        const post = () => opts.post(resultPath, ok
          ? { Body: { stkCallback: {
              MerchantRequestID: merchantId, CheckoutRequestID: checkoutId, ResultCode: 0, ResultDesc: OK_DESC,
              // STK metadata uses `Name`, unlike B2C's `ResultParameter` entries which use `Key`.
              CallbackMetadata: { Item: [
                { Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: receipt },
                { Name: 'TransactionDate', Value: transactionDateValue() }, { Name: 'PhoneNumber', Value: phone },
              ] },
            } } }
          : { Body: { stkCallback: {
              MerchantRequestID: merchantId, CheckoutRequestID: checkoutId, ResultCode: 1032,
              ResultDesc: 'Request cancelled by user',
            } } });
        if (opts.callbackBeforeAck) await post();
        else {
          later(post);
          if (scenario === 'duplicatesCallback') later(post);
        }
      }
      // Accepted, but the answer never reached this server: a 5xx after the prompt exists. The
      // attempt's reference is unknown to the caller, exactly as a dropped connection leaves it.
      if (syncLost) {
        return json({ requestId: `fake-${n}`, errorCode: '500.001.1001', errorMessage: 'Service unavailable' }, 500);
      }
      return json({ MerchantRequestID: merchantId, CheckoutRequestID: checkoutId, ResponseCode: '0',
        ResponseDescription: ACCEPTED, CustomerMessage: 'Success. Request accepted for processing' });
    }

    if (path.endsWith('/transactionstatus/v1/query')) {
      // The risky shape: echo the request's own OriginatorConversationID when
      // present — a query about payment X gets an ack whose OCID equals X's own OCID, the exact
      // collision the matching logic fixes — and mint one only when the request carries none (a
      // lookup by receipt).
      const bodyOc = String(body.OriginatorConversationID ?? '');
      const queryOc = bodyOc || `fake-q-${n}`;
      if (scenario !== 'neverAnswers') {
        const byReceipt = String(body.TransactionID ?? '');
        const known = sent.get(bodyOc);
        const receipt = known?.receipt ?? (byReceipt || `RI${String(n).padStart(8, '0')}`);
        const amount = known?.amount ?? 1;
        const st = scenario === 'disagrees' ? 'Failed' : 'Completed';
        later(() => opts.post(resultPath, statusResult(queryOc, conv, st, receipt, amount)));
      }
      return json({ ConversationID: conv, OriginatorConversationID: queryOc, ResponseCode: '0', ResponseDescription: ACCEPTED });
    }

    if (path.endsWith('/accountbalance/v1/query')) {
      const oc = `fake-bal-${n}`;
      const ok = scenario !== 'credentialError';
      if (scenario !== 'neverAnswers') later(() => opts.post(resultPath, balanceResult(oc, conv, ok)));
      return json({ ConversationID: conv, OriginatorConversationID: oc, ResponseCode: '0', ResponseDescription: ACCEPTED });
    }

    if (path.includes('/billmanager-invoice/')) {
      if (path.endsWith('/optin') || path.endsWith('/change-optin-details')) {
        billManagerUrl = pathOf(String(body.callbackurl ?? ''));
        return json({ rescode: '200', resmsg: 'Success', app_key: 'fake-app-key' });
      }
      return json({ rescode: '200', resmsg: 'Success', Status_Message: 'Invoice sent successfully' });
    }
    if (path.endsWith('/createStandingOrderExternal')) {
      const ref = `fake-ratiba-${n}`;
      const cbPath = pathOf(String(body.CallBackURL ?? ''));
      if (scenario !== 'losesCallback' && scenario !== 'neverAnswers') {
        const ok = scenario !== 'credentialError';
        const post = () => opts.post(cbPath, {
          responseHeader: { responseRefID: ref, requestRefID: `req-${n}`, responseCode: ok ? '0' : '1', responseDescription: ok ? 'Request accepted for processing' : 'The customer declined' },
          responseBody: { responseData: ok ? [{ name: 'TransactionID', value: `RS${String(n).padStart(8, '0')}` }, { name: 'Status', value: 'Active' }, { name: 'Msisdn', value: String(body.PartyA ?? '') }] : [] },
        });
        later(post);
        if (scenario === 'duplicatesCallback') later(post);
      }
      return json({ ResponseHeader: { responseRefID: ref, responseCode: '200', responseDescription: 'Request accepted', ResultDesc: 'The service request is being processed' } });
    }
    if (path.endsWith('/ussdpush/get-msisdn')) {
      const ref = String(body.RequestRefID ?? `fake-ex-${n}`);
      const cbPath = pathOf(String(body.callbackUrl ?? ''));
      const amount = Number(body.amount);
      if (scenario !== 'losesCallback' && scenario !== 'neverAnswers') {
        const ok = scenario !== 'credentialError';
        const post = () => opts.post(cbPath, ok
          ? { resultCode: '0', resultDesc: 'The service request is processed successfully.', requestId: ref, amount: String(amount), paymentReference: String(body.paymentRef ?? ''), resultType: '0', conversationID: `AG_ex_${n}`, transactionId: `RX${String(n).padStart(8, '0')}`, status: 'SUCCESS' }
          : { resultCode: '1', resultDesc: 'The initiator declined', requestId: ref, amount: String(amount), status: 'FAILED' });
        later(post);
        if (scenario === 'duplicatesCallback') later(post);
      }
      return json({ code: '0', status: 'USSD Initiated Successfully' });
    }
    if (path.endsWith('/lipa/na/bonga/calculate-points')) {
      const points = Number(body.points);
      return json({ header: { requestRefId: `fake-bc-${n}`, responseCode: 200, responseMessage: 'Success' }, body: { amount: String(points * 0.2), points: String(points), rate: '0.2' } });
    }
    if (path.endsWith('/lipa/na/bonga/redeem-paybill')) {
      const ref = `fake-br-${n}`;
      const amount = Number(body.amount);
      const phone = String(body.msisdn ?? '');
      const account = String(body.accountNumber ?? '');
      if (scenario !== 'losesCallback' && scenario !== 'neverAnswers' && scenario !== 'credentialError' && c2bConfirmUrl) {
        const id = `RB${String(n).padStart(8, '0')}`;
        paid.push({ receipt: id, amount, phone, account, at: new Date() });
        const at = new Date(Date.now() + 3 * 3_600_000); const p = (v: number) => String(v).padStart(2, '0');
        const transTime = `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`;
        later(() => opts.post(c2bConfirmUrl!, { TransactionType: 'Pay Bill', TransID: id, TransTime: transTime, TransAmount: String(amount), BusinessShortCode: '600999', BillRefNumber: account, InvoiceNumber: '', OrgAccountBalance: String(utility + amount), ThirdPartyTransID: '', MSISDN: phone, FirstName: 'Jane', MiddleName: '', LastName: 'Doe' }));
      }
      return json({ header: { requestRefId: ref, responseCode: 200, responseMessage: 'Success', customerMessage: 'Enter your PIN to pay with points' } });
    }
    if (path.endsWith('/registerurl')) {
      c2bConfirmUrl = pathOf(String(body.ConfirmationURL ?? ''));
      return json({ OriginatorCoversationID: `fake-c2b-${n}`, ResponseCode: '0', ResponseDescription: 'Success' });
    }
    if (path.endsWith('/pulltransactions/v1/register')) {
      return json({ ResponseRefID: `fake-pull-${n}`, 'Response Status': '1000', ShortCode: body.ShortCode, 'Response Description': 'Short Code registered successfully' });
    }
    if (path.endsWith('/pulltransactions/v1/query')) {
      const offset = Number(body.OffSetValue ?? 0);
      const rows = paid.slice(offset, offset + 100).map((p) => ({
        transactionId: p.receipt, trxDate: p.at.toISOString().replace('T', ' ').slice(0, 19), msisdn: p.phone, sender: 'JANE DOE',
        transactiontype: 'c2b-pay-bill-debit', billreference: p.account, amount: String(p.amount), organizationname: 'ACME',
      }));
      return json({ ResponseRefID: `fake-pq-${n}`, ResponseCode: '1000', ResponseMessage: 'Success', Response: [rows] });
    }

    if (path.endsWith('/sfcverify/v1/query/info')) {
      if (orgInfoName === null) {
        return json({ requestId: `fake-${n}`, errorCode: '500.001.1001', errorMessage: 'Service unavailable' }, 500);
      }
      if (orgInfoName === false) {
        return json({
          ConversationID: conv, ResponseCode: '1', ResponseMessage: 'Invalid Identifier', DetailedMessage: 'Invalid Identifier',
          OrganizationShortCode: String(body.Identifier ?? ''), OrganizationName: '', ChargeProfileID: '1',
        });
      }
      return json({
        ConversationID: conv, ResponseCode: '0', ResponseMessage: 'Success', DetailedMessage: 'Success',
        OrganizationShortCode: String(body.Identifier ?? ''), OrganizationName: orgInfoName, ChargeProfileID: '1',
      });
    }

    return json({ requestId: `fake-${n}`, errorCode: '404.001.03', errorMessage: 'Invalid Access Token' }, 404);
  }) as typeof fetch;

  const set = (s: Scenario) => () => { scenario = s; sync = null; };
  return {
    fetchImpl, calls,
    completes: set('completes'), losesCallback: set('losesCallback'), disagrees: set('disagrees'),
    duplicatesCallback: set('duplicatesCallback'), neverAnswers: set('neverAnswers'), credentialError: set('credentialError'),
    rejectsSync(code, desc) { scenario = 'completes'; sync = { code, desc }; },
    losesSync() { syncLost = true; },
    refusesV3() { v3Refused = true; },
    knowsShortcodeAs(name) { orgInfoName = name; },
    dateAt(at) { fixedDate = at; },
    async customerPaysInvoice({ account, amount, phone = '254700123456', transactionId }) {
      n += 1;
      const id = transactionId ?? `BM${String(n).padStart(8, '0')}`;
      if (billManagerUrl) await opts.post(billManagerUrl, { transactionId: id, paidAmount: amount, msisdn: phone, dateCreated: new Date().toISOString(), accountReference: account, shortCode: '600999' });
      return id;
    },
    async customerPays({ amount, phone, account, receipt, deliver = true }) {
      n += 1;
      const id = receipt ?? `RC${String(n).padStart(8, '0')}`;
      paid.push({ receipt: id, amount, phone, account, at: new Date() });
      if (deliver && c2bConfirmUrl) {
        const at = new Date(Date.now() + 3 * 3_600_000); const p = (v: number) => String(v).padStart(2, '0');
        const transTime = `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`;
        utility += amount;
        await opts.post(c2bConfirmUrl, {
          TransactionType: 'Pay Bill', TransID: id, TransTime: transTime, TransAmount: String(amount), BusinessShortCode: '600999', BillRefNumber: account,
          InvoiceNumber: '', OrgAccountBalance: String(utility), ThirdPartyTransID: '', MSISDN: phone, FirstName: 'Jane', MiddleName: '', LastName: 'Doe',
        });
      }
      return id;
    },
    reset() { scenario = 'completes'; sync = null; syncLost = false; v3Refused = false; orgInfoName = 'ACME TRADERS'; fixedDate = null; calls.length = 0; queue.length = 0; sent.clear(); stk.clear(); utility = 34392; paid.length = 0; c2bConfirmUrl = null; billManagerUrl = null; },
    async settle() { while (queue.length) { const fn = queue.shift()!; await fn().catch(() => {}); } },
  };
}
