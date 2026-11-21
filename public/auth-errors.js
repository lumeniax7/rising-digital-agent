export function apiFailure(path, ok, status, body = {}) {
  if (status === 401 && path !== "/api/login") {
    return { message: "Session expirée", requiresLogin: true };
  }
  if (!ok) {
    return { message: body?.error || `HTTP ${status}`, requiresLogin: false };
  }
  return null;
}
