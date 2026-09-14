export function callbackUrls(publicUrl: string, secret: string) {
  const base = `${publicUrl.replace(/\/+$/, '')}/cb/${secret}`;
  return {
    base,
    b2c: `${base}/b2c`, b2cTimeout: `${base}/b2c/timeout`, b2b: `${base}/b2b`, status: `${base}/status`, reversal: `${base}/reversal`,
    balance: `${base}/balance`, stk: `${base}/stk`, c2bValidate: `${base}/c2b/validate`, c2bConfirm: `${base}/c2b/confirm`,
    pull: `${base}/pull`, ratiba: `${base}/ratiba`, express: `${base}/express`, billManager: `${base}/billmanager`,
    selftest: `${base}/selftest`,
  };
}
