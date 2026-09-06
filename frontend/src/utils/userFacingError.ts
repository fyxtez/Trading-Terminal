const TECHNICAL_ERROR_PATTERN =
  /backend|sidecar|localhost|127\.0\.0\.1|loopback|websocket|\bhttp\b|endpoint|payload|response|request|runtime|sqlite|cache|json|parse|econn|failed to fetch|network error|connection failed|service unavailable|timed? ?out/i;

const SAVED_CONNECTION_ERROR_PATTERN =
  /credential|keyring|secret service|secure storage|password store/i;

/**
 * Keeps implementation details out of messages rendered to customers while
 * preserving already-readable validation messages from Binance and the app.
 */
export function userFacingError(
  reason: unknown,
  fallback = "Something went wrong. Please try again.",
): string {
  const raw = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  const message = raw.trim();

  if (!message) return fallback;
  if (SAVED_CONNECTION_ERROR_PATTERN.test(message)) {
    return "Terminal could not open your saved connections. Unlock your device and try again.";
  }
  if (TECHNICAL_ERROR_PATTERN.test(message)) {
    return fallback;
  }
  return message;
}
