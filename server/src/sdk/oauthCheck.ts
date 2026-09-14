const BASE = { sandbox: 'https://sandbox.safaricom.co.ke', production: 'https://api.safaricom.co.ke' } as const;

export async function oauthCheck(env: 'sandbox' | 'production', key: string, secret: string, fetchImpl: typeof fetch = fetch)
  : Promise<{ ok: true; expiresIn: number } | { ok: false; status: number; message: string }> {
  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  try {
    const r = await fetchImpl(`${BASE[env]}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return { ok: false, status: r.status, message: r.status === 400 || r.status === 401 ? 'Safaricom rejected the key or secret.' : `Safaricom answered ${r.status}.` };
    const text = await r.text();
    let body: { access_token?: string; expires_in?: string };
    try {
      body = JSON.parse(text) as { access_token?: string; expires_in?: string };
    } catch {
      return { ok: false, status: r.status, message: 'Safaricom answered, but not with a token. Check the environment setting.' };
    }
    if (!body.access_token) {
      return { ok: false, status: r.status, message: 'Safaricom answered without a token. Check the key and secret.' };
    }
    const expiresIn = Number(body.expires_in);
    return { ok: true, expiresIn: Number.isFinite(expiresIn) ? expiresIn : 3599 };
  } catch {
    return { ok: false, status: 0, message: 'Could not reach Safaricom. Check the internet connection.' };
  }
}
