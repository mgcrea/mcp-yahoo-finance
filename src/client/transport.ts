import https from "node:https";
import tls from "node:tls";

// Yahoo answers HTTP 429 to any client whose TLS ClientHello does not look like
// a browser's — on every request, crumb-less ones included, and from any IP.
// Node's default handshake (global `fetch`, `node:https`) is refused; the same
// request with Chrome's cipher order, key-exchange groups and signature
// algorithms is served. Cookies and a crumb from a valid session do NOT get a
// non-browser handshake past it, so the fingerprint has to be fixed at the
// socket, which global `fetch` cannot do without the `undici` package. Hence
// this fetch-shaped wrapper over `node:https`, which takes TLS options directly.
// Measured 2026-10-03 on OpenSSL 3.5.5 and 3.6.4. HTTP/1.1 is enough; HTTP/2
// is not required. Expect this to drift as Chrome's own handshake does — the
// `live` CI job is what notices.
const CHROME_CIPHERS = [
  // TLS 1.3
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  // TLS 1.2, in Chrome's order
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

const CHROME_SIGALGS = [
  "ecdsa_secp256r1_sha256",
  "rsa_pss_rsae_sha256",
  "rsa_pkcs1_sha256",
  "ecdsa_secp384r1_sha384",
  "rsa_pss_rsae_sha384",
  "rsa_pkcs1_sha384",
  "rsa_pss_rsae_sha512",
  "rsa_pkcs1_sha512",
].join(":");

// Chrome leads with the post-quantum hybrid; OpenSSL only has it from 3.5, so
// probe once and drop it rather than fail every request on an older build.
const CHROME_CURVES = "X25519MLKEM768:X25519:P-256:P-384";
const FALLBACK_CURVES = "X25519:P-256:P-384";

export const chromeCurves = (create = tls.createSecureContext): string => {
  try {
    create({ ecdhCurve: CHROME_CURVES });
    return CHROME_CURVES;
  } catch {
    return FALLBACK_CURVES;
  }
};

// One keep-alive agent for the process: the handshake is the expensive part,
// and every Yahoo host shares the same TLS profile.
let agent: https.Agent | undefined;
const chromeAgent = (): https.Agent =>
  (agent ??= new https.Agent({
    keepAlive: true,
    ciphers: CHROME_CIPHERS,
    sigalgs: CHROME_SIGALGS,
    ecdhCurve: chromeCurves(),
    minVersion: "TLSv1.2",
  }));

// Statuses the Fetch spec forbids a body on; `new Response(body, …)` throws for them.
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const MAX_REDIRECTS = 5;

/** Build a fetch `Response` from a raw Node response, keeping every `set-cookie`. */
export const toResponse = (status: number, rawHeaders: string[], body: Buffer): Response => {
  const headers = new Headers();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    headers.append(rawHeaders[i]!, rawHeaders[i + 1]!);
  }
  return new Response(NULL_BODY.has(status) ? null : new Uint8Array(body), { status, headers });
};

const send = (url: URL, init: RequestInit): Promise<Response> =>
  new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" ? init.body : undefined;
    if (init.body != null && body === undefined) {
      reject(new TypeError("chromeFetch only sends string bodies"));
      return;
    }
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
    // An abort — before headers or mid-body — surfaces as a generic AbortError;
    // reject with the signal's own reason so callers see the TimeoutError fetch gives.
    const fail = (err: Error) => reject(init.signal?.aborted ? init.signal.reason : err);

    const req = https.request(
      url,
      {
        method: init.method ?? "GET",
        headers,
        agent: chromeAgent(),
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve(toResponse(res.statusCode ?? 0, res.rawHeaders, Buffer.concat(chunks))),
        );
        res.on("error", fail);
      },
    );
    req.on("error", fail);
    req.end(body);
  });

/**
 * A `fetch` for Yahoo that presents Chrome's TLS fingerprint. Supports what the
 * client and the crumb session use: GET and POST with a string body, headers,
 * `signal`, and `redirect: "manual"` or the default "follow" (GET hops only).
 */
export const chromeFetch: typeof fetch = async (input, init = {}) => {
  let url = new URL(input instanceof Request ? input.url : String(input));
  let res = await send(url, init);
  for (let hops = 0; init.redirect !== "manual" && hops < MAX_REDIRECTS; hops++) {
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) break;
    url = new URL(location, url);
    res = await send(url, { ...init, method: "GET", body: null });
  }
  return res;
};
