import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface RequestContext {
  requestId: string;
  tenantId?: string;
  actorId?: string;
}

export interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

export function requestContext(req: IncomingMessage): RequestContext {
  const requestId = String(req.headers["x-request-id"] ?? randomUUID());
  const tenantIdHeader = req.headers["x-tenant-id"];
  const actorIdHeader = req.headers["x-actor-id"];
  const tenantId = typeof tenantIdHeader === "string" ? tenantIdHeader : undefined;
  const actorId = typeof actorIdHeader === "string" ? actorIdHeader : undefined;
  return { requestId, tenantId, actorId };
}

export async function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let payload = "";
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on("data", (chunk) => {
      payload += decoder.write(chunk);
      if (payload.length > 2_000_000) {
        fail(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      payload += decoder.end();
      resolve(payload);
    });

    req.on("error", fail);
  });
}

/**
 * Reads the raw request body as bytes. Unlike `readRawBody` (which decodes
 * UTF-8 and would corrupt binary payloads), this preserves the exact bytes —
 * required for media uploads.
 */
export async function readBinaryBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Stop consuming but leave the socket intact so the caller can still
        // write a 413 response; destroying here would turn every oversized
        // upload into a client-side ECONNRESET with no status or body. The
        // caller tears the request down after replying.
        req.pause();
        const error = new Error("Request body too large") as Error & { code: string };
        error.code = "BODY_TOO_LARGE";
        fail(error);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });

    req.on("error", fail);
  });
}

export async function readJsonBody<TPayload>(req: IncomingMessage): Promise<TPayload> {
  const payload = await readRawBody(req);
  if (payload.trim() === "") {
    return {} as TPayload;
  }
  return JSON.parse(payload) as TPayload;
}

export function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(text));
  res.end(text);
}

export function sendNoContent(res: ServerResponse): void {
  res.statusCode = 204;
  res.end();
}

export function hashPayload(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseUrlPath(input: string | undefined): string {
  if (!input) {
    return "/";
  }
  const [path] = input.split("?");
  return path || "/";
}

export function parseQuery(input: string | undefined): URLSearchParams {
  if (!input || !input.includes("?")) {
    return new URLSearchParams();
  }
  const parts = input.split("?");
  return new URLSearchParams(parts[1] ?? "");
}

export function methodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { error: "Method not allowed" });
}

export function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: "Not found" });
}
