import { timingSafeEqual } from 'node:crypto';

export const API_TOKEN_ENV = 'BUFFERFLOW_API_TOKEN';
export const MAX_BODY_BYTES_ENV = 'BUFFERFLOW_MAX_BODY_BYTES';
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

export interface AuthInput {
  authorization?: string | null;
  apiToken?: string | null;
  queryToken?: string | null;
}

/** Returns the configured shared API token, or null when auth is disabled. */
export function getConfiguredToken(): string | null {
  const token = process.env[API_TOKEN_ENV]?.trim();
  return token ? token : null;
}

export function isAuthEnabled(): boolean {
  return getConfiguredToken() !== null;
}

/** Clamped environment-configurable request body limit. */
export function getMaxRequestBodyBytes(): number {
  const configured = Number(process.env[MAX_BODY_BYTES_ENV]);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_MAX_BODY_BYTES;
  }
  return Math.min(1024 * 1024 * 1024, Math.floor(configured));
}

/** Only `/api/*` and the `/ws` upgrade are protected; static assets stay public. */
export function isProtectedPath(pathname: string): boolean {
  return pathname === '/ws' || pathname.startsWith('/api/');
}

export function extractApiToken(input: AuthInput): string | null {
  const headerToken = input.apiToken?.trim();
  if (headerToken) return headerToken;

  const authorization = input.authorization?.trim();
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (match?.[1]) return match[1].trim();
  }

  const queryToken = input.queryToken?.trim();
  if (queryToken) return queryToken;

  return null;
}

/** Constant-time comparison; length mismatch is rejected without comparing. */
export function tokensMatch(provided: string | null, configured: string): boolean {
  if (!provided) return false;
  const providedBuffer = Buffer.from(provided, 'utf8');
  const configuredBuffer = Buffer.from(configured, 'utf8');
  if (providedBuffer.length !== configuredBuffer.length) return false;
  return timingSafeEqual(providedBuffer, configuredBuffer);
}

/**
 * Evaluates a request. When BUFFERFLOW_API_TOKEN is unset, every request is
 * authorized (development default). When set, a matching bearer token,
 * `x-api-token` header, or `?token=` query parameter is required.
 */
export function isAuthorized(input: AuthInput): boolean {
  const configured = getConfiguredToken();
  if (!configured) return true;
  return tokensMatch(extractApiToken(input), configured);
}

export function isRequestBodyTooLarge(
  contentLength: string | null | undefined,
  maxBodyBytes: number = getMaxRequestBodyBytes()
): boolean {
  if (!contentLength) return false;
  const length = Number(contentLength);
  return Number.isFinite(length) && length > maxBodyBytes;
}
