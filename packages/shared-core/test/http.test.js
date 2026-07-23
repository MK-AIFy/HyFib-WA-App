import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { readBinaryBody } from "../dist/http.js";

test("readBinaryBody round-trips binary bytes exactly", async () => {
  // Includes invalid-UTF8 sequences that a string decoder would corrupt.
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x80, 0xfe, 0x01]);
  const stream = new PassThrough();
  const pending = readBinaryBody(stream, 1024);
  stream.write(bytes.subarray(0, 4));
  stream.write(bytes.subarray(4));
  stream.end();

  const result = await pending;
  assert.equal(Buffer.compare(result, bytes), 0);
});

test("readBinaryBody rejects bodies past the limit", async () => {
  const stream = new PassThrough();
  const pending = readBinaryBody(stream, 8);
  stream.write(Buffer.alloc(9, 1));

  await assert.rejects(pending, /Request body too large/);
});

test("readBinaryBody resolves empty for an empty body", async () => {
  const stream = new PassThrough();
  const pending = readBinaryBody(stream, 8);
  stream.end();

  const result = await pending;
  assert.equal(result.length, 0);
});

test("readBinaryBody rejects over-limit bodies with code BODY_TOO_LARGE without destroying the stream", async () => {
  const stream = new PassThrough();
  const pending = readBinaryBody(stream, 8);
  stream.write(Buffer.alloc(9, 1));

  await assert.rejects(pending, (err) => err.code === "BODY_TOO_LARGE");
  // The socket must stay writable so the caller can still deliver a 413
  // response; the caller is responsible for tearing the request down after.
  assert.equal(stream.destroyed, false);
});

test("readBinaryBody propagates stream errors without the BODY_TOO_LARGE code", async () => {
  const stream = new PassThrough();
  const pending = readBinaryBody(stream, 8);
  const boom = new Error("connection reset");
  stream.emit("error", boom);

  await assert.rejects(pending, (err) => err === boom && err.code === undefined);
});
