/* =====================================================================
   PINs and session tokens.

   What a PIN is worth: it is four digits, so ten thousand guesses covers
   the space. Hashing it stops someone reading PINs straight out of a
   database dump, and the sign-in endpoint is rate-limited, but a 4-digit
   PIN is not a cryptographic secret and this file does not pretend it is.
   The real boundary is the session token below: it is scoped to one
   account, carries that account's role, expires, and cannot be minted
   without SESSION_SECRET, which only the Worker holds.
   ===================================================================== */

const ITERATIONS = 210000;
const SESSION_MS = 12 * 60 * 60 * 1000;   // one long shift

const enc = new TextEncoder();

function b64url(bytes) {
  var bin = '';
  new Uint8Array(bytes).forEach(function (b) { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  var bin = atob(s);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomSalt() {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

export async function hashPin(pin, salt) {
  var key = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  var bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(String(salt)), iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return b64url(bits);
}

/* Compares in constant time, so a wrong PIN cannot be narrowed down by
   how long the answer took to come back. */
export function safeEqual(a, b) {
  var x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  var diff = 0;
  for (var i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function signingKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
}

/* Stateless sessions: the token carries its own claims and a signature
   over them, so a sign-in needs no session table and no second round
   trip on every later request. */
export async function mintToken(secret, claims, ttlMs) {
  var payload = Object.assign({}, claims, {
    iat: Date.now(),
    exp: Date.now() + (ttlMs || SESSION_MS)
  });
  var body = b64url(enc.encode(JSON.stringify(payload)));
  var sig = await crypto.subtle.sign('HMAC', await signingKey(secret), enc.encode(body));
  return { token: body + '.' + b64url(sig), expiresAt: payload.exp, claims: payload };
}

export async function readToken(secret, token) {
  var parts = String(token || '').split('.');
  if (parts.length !== 2) return null;

  var expected = b64url(await crypto.subtle.sign('HMAC', await signingKey(secret), enc.encode(parts[0])));
  if (!safeEqual(expected, parts[1])) return null;

  try {
    var claims = JSON.parse(new TextDecoder().decode(unb64url(parts[0])));
    if (!claims.exp || claims.exp < Date.now()) return null;
    return claims;
  } catch (e) {
    return null;
  }
}

export { SESSION_MS };
