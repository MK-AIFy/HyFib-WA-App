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

    req.on("data", (chunk) => {
      payload += decoder.write(chunk);
      if (payload.length > 2_000_000) {
        reject(new Error("Request body too large"));
      }
    });

    req.on("end", () => {
      payload += decoder.end();
      resolve(payload);
    });

    req.on("error", reject);
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
