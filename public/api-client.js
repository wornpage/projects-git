// The browser's single HTTP boundary. No automatic mutation retries.
export function workspaceAccessLost(error) {
  return Boolean(error?.auth||error?.accessLost||error?.status===401||[
    'UNAUTHORIZED','FORBIDDEN','SESSION_EXPIRED','SESSION_REVOKED','WORKSPACE_FORBIDDEN','WORKSPACE_OWNER_MISMATCH',
    'HUMAN_IDENTITY_REQUIRED','TRIAL_NOT_ADMITTED','TRIAL_CLOSED','TRIAL_EXPIRED','TRIAL_IDENTITY_FORBIDDEN','TRIAL_IDENTITY_CHANGED','TRIAL_SAMPLE_FORBIDDEN',
  ].includes(error?.code));
}
export function createApiClient({captureSession = () => () => true, onAuthRequired, onAccessLost, fetchRequest = fetch}) {
  return async function api(path, body, requestKey) {
    const isCurrent = captureSession();
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (requestKey) headers['Idempotency-Key'] = requestKey;
    let response;
    try { response = await fetchRequest(path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: "no-store", redirect: 'manual' }); }
    catch { const error=new Error("The workspace could not be reached. Check the server connection."); error.uncertain=body!==undefined; throw error; }
    if (response.status === 401 || response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400) {
      const error = new Error("Sign in through Cloudflare Access to open this workspace.");
      error.auth = true;
      if (isCurrent()) { if(onAccessLost)onAccessLost(error);else onAuthRequired?.(); }
      throw error;
    }
    let data;
    try { data = await response.json(); }
    catch {
      const error=new Error(response.status===403 ? 'Access to this workspace was denied. Check your signed-in identity.'
        : 'The server returned an unreadable response. Refresh status to confirm the outcome.');
      error.status=response.status;error.uncertain=body!==undefined;
      // Access may deny at the edge with HTML or an empty body. Project-level
      // application refusals use structured JSON and keep their normal handling.
      if(response.status===403){error.code='FORBIDDEN';if(isCurrent())onAccessLost?.(error);}
      throw error;
    }
    if (!response.ok) {
      const message = typeof data.error === "string" ? data.error : data.error?.message || data.message || `Request failed (${response.status}).`;
      const error = new Error(String(message));
      error.status = response.status;
      error.uncertain = body!==undefined && response.status>=500;
      error.code = data.error?.code ?? data.code;
      if (isCurrent() && workspaceAccessLost(error)) onAccessLost?.(error);
      throw error;
    }
    return data;
  }

}
