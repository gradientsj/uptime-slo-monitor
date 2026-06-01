import test from "node:test";
import assert from "node:assert/strict";
import { authorizeProbeRequest } from "../src/lib/probeAuth";

test("authorizeProbeRequest accepts the configured bearer token", () => {
  const req = new Request("https://monitor.test/api/probe", {
    headers: { authorization: "Bearer secret" },
  });

  assert.equal(authorizeProbeRequest(req, "secret", "production"), "authorized");
});

test("authorizeProbeRequest accepts the configured query token", () => {
  const req = new Request("https://monitor.test/api/probe?token=secret");

  assert.equal(authorizeProbeRequest(req, "secret", "production"), "authorized");
});

test("authorizeProbeRequest rejects spoofable cron headers without the secret", () => {
  const req = new Request("https://monitor.test/api/probe", {
    headers: { "x-vercel-cron": "1" },
  });

  assert.equal(authorizeProbeRequest(req, "secret", "production"), "unauthorized");
});

test("authorizeProbeRequest fails closed in production when CRON_SECRET is missing", () => {
  const req = new Request("https://monitor.test/api/probe");

  assert.equal(authorizeProbeRequest(req, undefined, "production"), "missing_secret");
});

test("authorizeProbeRequest allows local development without CRON_SECRET", () => {
  const req = new Request("http://localhost:3000/api/probe");

  assert.equal(authorizeProbeRequest(req, undefined, "development"), "authorized");
});
