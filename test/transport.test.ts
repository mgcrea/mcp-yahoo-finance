import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { YahooFinanceApiError } from "#/client/errors";
import { limitFetch } from "#/client/limit";
import { chromeCurves, chromeFetch, toResponse } from "#/client/transport";

// What this file cannot check is the point of the transport: whether Yahoo
// accepts the fingerprint. Only Yahoo can answer that — see the `live` CI job.

describe("toResponse", () => {
  it("keeps every set-cookie header, which the crumb session depends on", () => {
    const res = toResponse(
      200,
      ["Set-Cookie", "A1=one; Path=/", "Content-Type", "text/html", "Set-Cookie", "A3=three"],
      Buffer.from("ok"),
    );
    expect(res.headers.getSetCookie()).toEqual(["A1=one; Path=/", "A3=three"]);
    expect(res.headers.get("content-type")).toBe("text/html");
  });

  it.each([204, 304])("gives a %i a null body instead of throwing", async (status) => {
    const res = toResponse(status, [], Buffer.alloc(0));
    expect(res.status).toBe(status);
    expect(res.body).toBeNull();
  });

  it("keeps a redirect's location for redirect: manual", () => {
    const res = toResponse(302, ["Location", "https://guce.yahoo.com/consent"], Buffer.alloc(0));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://guce.yahoo.com/consent");
  });
});

describe("chromeCurves", () => {
  it("leads with the post-quantum hybrid when OpenSSL has it", () => {
    expect(chromeCurves(() => ({}) as never)).toMatch(/^X25519MLKEM768:/);
  });

  it("drops it on an OpenSSL that rejects it, rather than failing every request", () => {
    expect(
      chromeCurves(() => {
        throw new Error("unknown group");
      }),
    ).toBe("X25519:P-256:P-384");
  });
});

describe("chromeFetch", () => {
  let server: net.Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("refuses a non-string body instead of sending it mangled", async () => {
    await expect(
      chromeFetch("https://127.0.0.1:1/", { method: "POST", body: new Uint8Array([1]) }),
    ).rejects.toThrow("string bodies");
  });

  it("aborts a stalled handshake as the same actionable timeout fetch gives", async () => {
    // Accepts the TCP connection and never speaks TLS: the handshake hangs.
    const sockets: net.Socket[] = [];
    server = net.createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;

    const limited = limitFetch(chromeFetch, { concurrency: 1, timeoutMs: 100 });
    const err = await limited(`https://127.0.0.1:${port}/`).catch((e: unknown) => e);
    for (const socket of sockets) socket.destroy();

    expect(err).toBeInstanceOf(YahooFinanceApiError);
    expect((err as Error).message).toContain("did not answer within 100 ms");
  });
});
