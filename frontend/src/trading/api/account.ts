import {
  AVAILABLE_BALANCE_ENDPOINT,
  TRADING_API_BASE_URL,
} from "../../config/constants";

const API_TOKEN = import.meta.env.VITE_TRADING_API_TOKEN;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

/*
 * Supports common backend response shapes:
 *
 * { "available_balance": 123.45 }
 * { "availableBalance": "123.45" }
 * { "balance": 123.45 }
 * { "data": { "available_balance": 123.45 } }
 */
function extractAvailableBalance(body: unknown): number | null {
  const direct = toFiniteNumber(body);

  if (direct !== null) {
    return direct;
  }

  if (!isRecord(body)) {
    return null;
  }

  const candidateKeys = [
    "available_balance",
    "availableBalance",
    "available",
    "balance",
  ] as const;

  for (const key of candidateKeys) {
    const value = toFiniteNumber(body[key]);

    if (value !== null) {
      return value;
    }
  }

  if ("data" in body) {
    return extractAvailableBalance(body.data);
  }

  return null;
}

export async function getAvailableBalance(
  signal?: AbortSignal,
): Promise<number> {
  const headers: HeadersInit = {
    Accept: "application/json",
  };

  if (API_TOKEN) {
    headers.Authorization = `Bearer ${API_TOKEN}`;
  }

  const response = await fetch(
    `${TRADING_API_BASE_URL}${AVAILABLE_BALANCE_ENDPOINT}`,
    {
      method: "GET",
      headers,
      signal,
    },
  );

  const contentType = response.headers.get("content-type");
  const isJson = contentType?.includes("application/json") ?? false;
  const body: unknown = isJson
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const backendMessage =
      isRecord(body) && typeof body.error === "string"
        ? body.error
        : typeof body === "string" && body.trim()
          ? body
          : `Balance request failed with status ${response.status}`;

    throw new Error(backendMessage);
  }

  const balance = extractAvailableBalance(body);

  if (balance === null) {
    throw new Error("Balance response did not contain a valid balance");
  }

  return balance;
}
