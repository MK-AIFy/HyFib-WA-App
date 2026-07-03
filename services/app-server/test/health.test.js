import test from "node:test";
import assert from "node:assert/strict";
import { createAppServer, createAppRequestHandler } from "../dist/main.js";

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };
const stubBus = { publish: async () => {}, subscribe: () => {}, close: async () => {} };

function bootServer() {
  const { server } = createAppServer({ logger: noopLogger, eventBus: stubBus });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

test("createAppRequestHandler is exported and callable", () => {
  const handler = createAppRequestHandler({ logger: noopLogger, eventBus: stubBus });
  assert.equal(typeof handler, "function");
});

test("GET /health returns 200 with ok status", async () => {
  const { server, base } = await bootServer();
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.service, "app-server");
    assert.equal(body.status, "ok");
    assert.ok(typeof body.timestamp === "string");
  } finally {
    server.close();
  }
});

test("GET /metrics returns 200", async () => {
  const { server, base } = await bootServer();
  try {
    const res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 200);
    await res.text();
  } finally {
    server.close();
  }
});

test("unknown route returns 404 route_not_found", async () => {
  const { server, base } = await bootServer();
  try {
    const res = await fetch(`${base}/api/v1/does-not-exist`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "route_not_found");
  } finally {
    server.close();
  }
});
