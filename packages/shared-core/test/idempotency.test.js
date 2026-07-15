import test from "node:test";
import assert from "node:assert/strict";
import { IdempotencyStore, RedisIdempotencyStore } from "../dist/index.js";

test("in-memory IdempotencyStore: claim -> release -> claim again succeeds", async () => {
  const store = new IdempotencyStore(60_000);

  assert.equal(store.isDuplicate("key-1"), false); // first claim succeeds
  assert.equal(store.isDuplicate("key-1"), true); // second claim is a duplicate

  await store.release("key-1");

  assert.equal(store.isDuplicate("key-1"), false); // claim succeeds again after release
});

test("in-memory IdempotencyStore: releasing an unclaimed key is a no-op", async () => {
  const store = new IdempotencyStore(60_000);
  await assert.doesNotReject(() => store.release("never-claimed"));
});

test("RedisIdempotencyStore exposes a release method (interface presence)", () => {
  assert.equal(typeof RedisIdempotencyStore.prototype.release, "function");
});

test("RedisIdempotencyStore.release DELs the namespaced key used by isDuplicate/claim", async () => {
  const deleted = [];
  const fakeRedis = {
    store: new Map(),
    async set(key, value, expiryMode, time, setMode) {
      if (this.store.has(key)) {
        return null;
      }
      this.store.set(key, value);
      return "OK";
    },
    async del(key) {
      deleted.push(key);
      const existed = this.store.delete(key);
      return existed ? 1 : 0;
    }
  };
  const store = new RedisIdempotencyStore(fakeRedis, 60, "idm:");

  assert.equal(await store.isDuplicate("webhook:abc"), false); // claims idm:webhook:abc
  assert.equal(await store.isDuplicate("webhook:abc"), true); // duplicate while claimed

  await store.release("webhook:abc");

  assert.deepEqual(deleted, ["idm:webhook:abc"]);
  assert.equal(await store.isDuplicate("webhook:abc"), false); // claim succeeds again after release
});
