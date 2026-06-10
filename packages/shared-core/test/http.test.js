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
