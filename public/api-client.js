// The browser's single HTTP boundary. No automatic mutation retries.
export function createApiClient({captureSession = () => () => true, onAuthRequired, fetchRequest = fetch}) {
  return async function api(path, body, requestKey) {
    const isCurrent = captureSession();
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (requestKey) headers['Idempotency-Key'] = requestKey;
    let response;
    try { response = await fetchRequest(path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: "no-store", redirect: 'manual' }); }
    catch { const error=new Error("The workspace could not be reached. Check the server connection."); error.uncertain=body!==undefined; throw error; }
    if (response.status === 401 || response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400) {
      if (isCurrent()) onAuthRequired();
      const error = new Error("Sign in through Cloudflare Access to open this workspace.");
      error.auth = true;
      throw error;
    }
    let data;
    try { data = await response.json(); }
    catch { const error=new Error("The server returned an unreadable response. Refresh status to confirm the outcome."); error.uncertain=body!==undefined; throw error; }
    if (!response.ok) {
      const message = typeof data.error === "string" ? data.error : data.error?.message || data.message || `Request failed (${response.status}).`;
      const error = new Error(String(message));
      error.status = response.status;
      error.uncertain = body!==undefined && response.status>=500;
      error.code = data.error?.code ?? data.code;
      throw error;
    }
    return data;
  }

}
