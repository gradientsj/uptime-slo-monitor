import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { probeOnce } from "../src/lib/probe";
import type { ServiceConfig } from "../src/lib/config";

function service(url: string, overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name: "local-api",
    url,
    method: "GET",
    expect_status: [200],
    timeout_ms: 500,
    window_days: 30,
    availability_target: 0.99,
    latency_percentile: 95,
    latency_target_ms: 800,
    ...overrides,
  };
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

test("probeOnce records successful expected statuses and latency", async () => {
  const server = await withServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });

  try {
    const result = await probeOnce(
      service(server.url, { expect_status: [204] })
    );

    assert.equal(result.service, "local-api");
    assert.equal(result.ok, true);
    assert.equal(result.status_code, 204);
    assert.equal(result.error, null);
    assert.ok(result.latency_ms !== null && result.latency_ms >= 0);
  } finally {
    await server.close();
  }
});

test("probeOnce turns unexpected statuses into failed probe results", async () => {
  const server = await withServer((_req, res) => {
    res.writeHead(500);
    res.end("error");
  });

  try {
    const result = await probeOnce(service(server.url));

    assert.equal(result.ok, false);
    assert.equal(result.status_code, 500);
    assert.equal(result.error, "unexpected status 500");
  } finally {
    await server.close();
  }
});

test("probeOnce returns a timeout failure instead of throwing", async () => {
  const server = await withServer((_req, res) => {
    setTimeout(() => {
      if (!res.destroyed) res.end("late");
    }, 100);
  });

  try {
    const result = await probeOnce(service(server.url, { timeout_ms: 20 }));

    assert.equal(result.ok, false);
    assert.equal(result.status_code, null);
    assert.equal(result.error, "timeout after 20ms");
    assert.ok(result.latency_ms !== null && result.latency_ms >= 0);
  } finally {
    await server.close();
  }
});
