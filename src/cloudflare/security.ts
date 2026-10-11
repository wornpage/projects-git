export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return json({ error: error.message, code: error.code }, error.status);
  }
  // Provider exception text can contain credentials. Never expose or log it.
  return json({ error: "The operation failed; retry with the same idempotency key.", code: "OPERATION_FAILED" }, 502);
}

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if ((origin !== null && origin !== new URL(request.url).origin) ||
      (site !== null && site !== "same-origin" && site !== "none")) {
    throw new ApiError(403, "CROSS_ORIGIN", "Browser mutations must use the same origin.");
  }
}

export function idempotencyKey(request: Request): string {
  const key = request.headers.get("Idempotency-Key") ?? "";
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) {
    throw new ApiError(400, "IDEMPOTENCY_REQUIRED", "Send an Idempotency-Key of 8-128 letters, numbers, dots, colons, underscores, or hyphens.");
  }
  return key;
}

export async function bodyJson(request: Request, forbiddenSecrets: string[] = [], limit = 32_768): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "JSON_REQUIRED", "Use application/json.");
  }
  const declared = request.headers.get("Content-Length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new ApiError(413, "BODY_TOO_LARGE", `Request bodies are limited to ${limit / 1024} KiB.`);
  }
  if (!request.body) throw new ApiError(400, "INVALID_JSON", "A JSON object is required.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let length = 0;
  let raw = "";
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new ApiError(413, "BODY_TOO_LARGE", `Request bodies are limited to ${limit / 1024} KiB.`);
      }
      raw += decoder.decode(item.value, { stream: true });
    }
    raw += decoder.decode();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    if (forbiddenSecrets.some(secret => secret && JSON.stringify(value).includes(secret))) {
      throw new ApiError(400, "SECRET_IN_BODY", "Credentials cannot be saved as workflow data.");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "INVALID_JSON", "A valid UTF-8 JSON object is required.");
  } finally {
    reader.releaseLock();
  }
}

export function text(value: unknown, field: string, maximum = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new ApiError(400, "INVALID_INPUT", `${field} must be nonempty text of at most ${maximum} characters.`);
  }
  return value.trim();
}

export function commitId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new ApiError(422, "ARTIFACTS_COMMIT_FORMAT", "Artifacts requires a full lowercase 40-character Git SHA-1 commit ID.");
  }
  return value;
}
