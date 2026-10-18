const SECRET = /^[a-f0-9]{64}$/;
const STORAGE_KEY = "fyxtez:opcore-embedded-session";
const PARENTS = [
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://127.0.0.1:37373",
];
if (import.meta.env.DEV) PARENTS.push("http://127.0.0.1:1420", "http://127.0.0.1:31420");

function readContext() {
  const query = new URLSearchParams(window.location.search);
  const parentOrigin = query.get("parentOrigin") ?? "";
  const instance = query.get("instance") ?? "";
  if (
    window.self === window.top ||
    window.location.origin !== "https://terminal.fyxtez.com" ||
    query.get("embed") !== "opcore" ||
    !PARENTS.includes(parentOrigin) ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(instance)
  )
    return null;
  return { parentOrigin, instance };
}

// Keep the frame context when the chart changes the symbol URL.
export const embeddedTerminalContext = readContext();
export const isEmbeddedTerminal = () => embeddedTerminalContext !== null;
type Credentials = { sessionSecret: string; sessionProof: string };
let credentials: Credentials | null = null;

export function getEmbeddedCredentials(): Credentials | null {
  if (!isEmbeddedTerminal()) return null;
  if (credentials) return credentials;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Credentials | null;
    if (saved && SECRET.test(saved.sessionSecret) && SECRET.test(saved.sessionProof))
      credentials = saved;
  } catch {
    /* Storage can be blocked in an embedded browser; this visit still works. */
  }
  return credentials;
}

export function storeEmbeddedCredentials(value: Credentials) {
  if (
    !isEmbeddedTerminal() ||
    !SECRET.test(value.sessionSecret) ||
    !SECRET.test(value.sessionProof)
  )
    throw new Error("Invalid Terminal connection response.");
  credentials = { sessionSecret: value.sessionSecret, sessionProof: value.sessionProof };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
  } catch {
    /* Retain the connection in memory for this visit. */
  }
}

export function clearEmbeddedCredentials() {
  credentials = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Memory is cleared even when storage is blocked. */
  }
}

export function embeddedSessionHeaders(): Record<string, string> {
  const saved = getEmbeddedCredentials();
  return saved ? { "x-fyxtez-embedded-session": saved.sessionSecret } : {};
}

export function notifyEmbeddedParent(
  status: "loading" | "ready" | "connect" | "unavailable",
  requestId?: string,
) {
  const context = embeddedTerminalContext;
  if (!context) return;
  // Only status and a public request ID cross the frame boundary. The request ID
  // cannot poll, approve, authenticate, or access the Terminal account by itself.
  window.parent.postMessage(
    {
      type: "fyxtez:embed",
      instance: context.instance,
      status,
      ...(requestId ? { requestId } : {}),
    },
    context.parentOrigin.startsWith("tauri:") ? "*" : context.parentOrigin,
  );
}
