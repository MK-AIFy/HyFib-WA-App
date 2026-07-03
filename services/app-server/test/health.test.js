import test from "node:test";
import assert from "node:assert/strict";
import { createAppServer } from "../dist/main.js";

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };
// Stub in-process bus: createGatewayHandler subscribes SSE fan-out onto it.
const stubBus = { publish: async () => {}, subscribe: () => {}, close: async () => {} };

function bootServer() {
  const { server, shutdown } = createAppServer({ logger: noopLogger, eventBus: stubBus });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, shutdown, base: `http://127.0.0.1:${port}` });
    });
  });
}

test("mounts the gateway: /auth/me without a token returns 401", async () => {
  const { server, base } = await bootServer();
  try {
    const res = await fetch(`${base}/auth/me`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Not authenticated");
  } finally {
    server.close();
  }
});

test("mounts the gateway: /metrics returns 200", async () => {
  const { server, base } = await bootServer();
  try {
    const res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 200);
    await res.text();
  } finally {
    server.close();
  }
});

test("unknown non-api route returns 404 route_not_found via gateway", async () => {
  const { server, base } = await bootServer();
  try {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "route_not_found");
  } finally {
    server.close();
  }
});
