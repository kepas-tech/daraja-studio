/**
 * Feature 12, second half. The VAPID key pair identifies this deployment to the browsers' push
 * services. It is generated on the server, kept in deploy/.env (mode 600) and never printed,
 * committed or reported. All three variables are needed together; none of them means web push is
 * simply off, which is a supported state: no button, no service worker, no sender.
 */
export interface Vapid {
  /** The public half. Not a secret: the browser is given it to check that a push came from here. */
  publicKey: string;
  /** The private half. Signs every push; never leaves the server. */
  privateKey: string;
  /** A mailto: or https: contact the push services can use if this deployment misbehaves. */
  subject: string;
}

/** 65 bytes in base64url is 87 characters, and a VAPID public key always starts with B. */
const PUBLIC_KEY_RE = /^B[A-Za-z0-9_-]{86}$/;
/** 32 bytes in base64url is 43 characters. */
const PRIVATE_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const SUBJECT_RE = /^(mailto:[^@\s]+@[^@\s]+|https:\/\/\S+)$/;

type Env = Record<string, string | undefined>;

/** An empty value is "not set", the convention the rest of the config follows. */
function read(env: Env, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value === '' ? undefined : value;
}

/**
 * Warn and stay off when the three do not line up. Throwing would take a live site down over an
 * optional feature, and silently ignoring a typo would leave the owner wondering why nothing
 * arrives; naming the variables that are wrong (never their values) is the honest middle.
 */
export function vapidFromEnv(env: Env): Vapid | null {
  const publicKey = read(env, 'STUDIO_VAPID_PUBLIC_KEY');
  const privateKey = read(env, 'STUDIO_VAPID_PRIVATE_KEY');
  const subject = read(env, 'STUDIO_VAPID_SUBJECT');
  if (!publicKey && !privateKey && !subject) return null;

  const wrong: string[] = [];
  if (!publicKey || !PUBLIC_KEY_RE.test(publicKey)) wrong.push('STUDIO_VAPID_PUBLIC_KEY');
  if (!privateKey || !PRIVATE_KEY_RE.test(privateKey)) wrong.push('STUDIO_VAPID_PRIVATE_KEY');
  if (!subject || !SUBJECT_RE.test(subject)) wrong.push('STUDIO_VAPID_SUBJECT');
  if (wrong.length > 0) {
    console.warn('web push is off: ' + wrong.join(', ') + (wrong.length === 1 ? ' is' : ' are') + ' missing or not in the expected shape (all three are needed together)');
    return null;
  }
  return { publicKey: publicKey!, privateKey: privateKey!, subject: subject! };
}
