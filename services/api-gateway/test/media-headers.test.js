import test from "node:test";
import assert from "node:assert/strict";
import { buildMediaHeaders } from "../dist/media-headers.js";

test("buildMediaHeaders: plain image gets Content-Type/Length/Disposition with quoted filename", () => {
  const headers = buildMediaHeaders({ mimeType: "image/jpeg", filename: "photo.jpg", byteLength: 4096 });
  assert.equal(headers["Content-Type"], "image/jpeg");
  assert.equal(headers["Content-Length"], "4096");
  assert.equal(headers["Content-Disposition"], 'inline; filename="photo.jpg"');
  assert.equal(headers["Cache-Control"], "private, max-age=86400");
});

test("buildMediaHeaders: missing mime falls back to octet-stream; missing filename omits the param", () => {
  const headers = buildMediaHeaders({ byteLength: 10 });
  assert.equal(headers["Content-Type"], "application/octet-stream");
  assert.equal(headers["Content-Disposition"], "inline");
  assert.equal(headers["Content-Length"], "10");
});

test("buildMediaHeaders: malicious filename is sanitized — no CR/LF/quote survives", () => {
  const headers = buildMediaHeaders({
    mimeType: "image/png",
    filename: 'evil"\r\nSet-Cookie: x=y.png',
    byteLength: 1
  });
  const disposition = headers["Content-Disposition"];
  // The raw header value must not contain CR or LF (header-injection vector),
  // and the only quotes present are the two that wrap the filename.
  assert.ok(!disposition.includes("\r"));
  assert.ok(!disposition.includes("\n"));
  assert.equal(disposition.split('"').length - 1, 2);
  assert.equal(disposition, 'inline; filename="evilSet-Cookie: x=y.png"');
});

test("buildMediaHeaders: long filename is capped at 150 characters", () => {
  const longName = "a".repeat(300) + ".png";
  const headers = buildMediaHeaders({ mimeType: "image/png", filename: longName, byteLength: 1 });
  const match = headers["Content-Disposition"].match(/^inline; filename="(.*)"$/);
  assert.ok(match, "expected a quoted filename param");
  assert.ok(match[1].length <= 150);
});
