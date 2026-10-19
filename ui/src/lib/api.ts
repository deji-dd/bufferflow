const TOKEN_KEY = 'bufferflow_api_token';

export function getStoredToken(): string | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    return token?.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

export function storeToken(token: string): void {
  try {
    const trimmed = token.trim();
    if (trimmed) localStorage.setItem(TOKEN_KEY, trimmed);
  } catch {
    // Storage can be unavailable in private/locked-down contexts.
  }
}

export function clearStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Ignore
  }
}

/**
 * Fetch wrapper that attaches the dashboard's API token (when present) as a
 * bearer token. Use this for every protected `/api/*` call.
 */
export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getStoredToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

/** Adds `?token=` for WebSocket/beacon URLs, which cannot send auth headers. */
export function withAuthQuery(url: string): string {
  const token = getStoredToken();
  if (!token) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}
