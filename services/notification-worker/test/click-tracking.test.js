import test from "node:test";
import assert from "node:assert/strict";
import { isTrackableUrl, generateLinkToken, mintTrackedParameters } from "../dist/click-tracking.js";

test("isTrackableUrl accepts absolute http/https URLs only", () => {
  assert.equal(isTrackableUrl("https://shop.example.com/sale"), true);
  assert.equal(isTrackableUrl("http://example.com"), true);
  assert.equal(isTrackableUrl("ftp://example.com"), false);
  assert.equal(isTrackableUrl("example.com/sale"), false);
  assert.equal(isTrackableUrl("Alice"), false);
  assert.equal(isTrackableUrl(""), false);
  assert.equal(isTrackableUrl("visit https://example.com now"), false);
});

test("generateLinkToken returns URL-safe unique tokens", () => {
  const tokens = new Set();
  for (let i = 0; i < 100; i++) {
    const token = generateLinkToken();
    assert.match(token, /^[A-Za-z0-9_-]{20,}$/);
    tokens.add(token);
  }
  assert.equal(tokens.size, 100);
});

test("mintTrackedParameters replaces URL params with shortlinks and stores destination", async () => {
  const created = [];
  const result = await mintTrackedParameters(["Alice", "https://shop.example.com/sale?x=1"], {
    baseUrl: "https://wa.hyfib.com/",
    createLink: async (token, destination) => {
      created.push({ token, destination });
    }
  });
  assert.equal(result[0], "Alice");
  assert.equal(created.length, 1);
  assert.equal(created[0].destination, "https://shop.example.com/sale?x=1");
  // Trailing slash on baseUrl must not produce a double slash.
  assert.equal(result[1], `https://wa.hyfib.com/r/${created[0].token}`);
});

test("mintTrackedParameters leaves non-URL params untouched and calls createLink once per URL", async () => {
  let calls = 0;
  const result = await mintTrackedParameters(["Bob", "20% off", "https://a.example", "https://b.example"], {
    baseUrl: "https://wa.hyfib.com",
    createLink: async () => {
      calls++;
    }
  });
  assert.equal(result[0], "Bob");
  assert.equal(result[1], "20% off");
  assert.equal(calls, 2);
  assert.notEqual(result[2], result[3]);
});

test("mintTrackedParameters falls back to the original URL when createLink fails", async () => {
  const errors = [];
  const result = await mintTrackedParameters(["https://shop.example.com/sale"], {
    baseUrl: "https://wa.hyfib.com",
    createLink: async () => {
      throw new Error("db down");
    },
    onError: (err, destination) => {
      errors.push({ err, destination });
    }
  });
  assert.equal(result[0], "https://shop.example.com/sale");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].destination, "https://shop.example.com/sale");
});

test("mintTrackedParameters returns params unchanged when no URLs present", async () => {
  let calls = 0;
  const params = ["Alice", "order 42"];
  const result = await mintTrackedParameters(params, {
    baseUrl: "https://wa.hyfib.com",
    createLink: async () => {
      calls++;
    }
  });
  assert.deepEqual(result, params);
  assert.equal(calls, 0);
});
