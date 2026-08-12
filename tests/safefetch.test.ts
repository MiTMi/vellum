/// <reference types="vite/client" />
// The SSRF guard behind linkPreview.fetchMeta and the agent's fetchUrl:
// forbidden hosts, redirect-hop re-validation, scheme gating.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { isForbiddenHost, safeFetch } from "../convex/lib/safefetch";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("private, loopback, metadata, and mapped hosts are forbidden", () => {
  for (const host of [
    "localhost", "sub.localhost", "127.0.0.1", "127.8.9.1", "10.0.0.1",
    "172.16.5.5", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "2130706433", "0x7f000001",
    "::1", "::", "[::1]", "fe80::1", "fd12::34", "::ffff:127.0.0.1",
    "224.0.0.1", "255.255.255.255",
  ]) {
    expect(isForbiddenHost(host), host).toBe(true);
  }
});

test("ordinary public hosts pass", () => {
  for (const host of ["example.com", "en.wikipedia.org", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) {
    expect(isForbiddenHost(host), host).toBe(false);
  }
});

test("forbidden URLs never reach fetch", async () => {
  expect(await safeFetch("http://169.254.169.254/latest/meta-data", {}, 1000)).toBeNull();
  expect(await safeFetch("ftp://example.com/x", {}, 1000)).toBeNull();
  expect(await safeFetch("http://127.0.0.1:8080/", {}, 1000)).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a redirect hop to a private address is refused", async () => {
  fetchMock.mockResolvedValueOnce({
    status: 302,
    headers: new Headers({ location: "http://169.254.169.254/creds" }),
  } as unknown as Response);
  const res = await safeFetch("https://evil.example/start", {}, 1000);
  expect(res).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1); // the private hop never fired
  expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
});

test("a legitimate redirect chain is followed and re-validated", async () => {
  fetchMock
    .mockResolvedValueOnce({
      status: 301,
      headers: new Headers({ location: "https://www.example.com/page" }),
    } as unknown as Response)
    .mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: new Headers(),
    } as unknown as Response);
  const res = await safeFetch("https://example.com/page", {}, 1000);
  expect(res?.status).toBe(200);
  expect(String(fetchMock.mock.calls[1][0])).toBe("https://www.example.com/page");
});

test("redirect loops give up after the hop cap", async () => {
  fetchMock.mockResolvedValue({
    status: 302,
    headers: new Headers({ location: "https://example.com/again" }),
  } as unknown as Response);
  expect(await safeFetch("https://example.com/loop", {}, 1000)).toBeNull();
  expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6);
});
