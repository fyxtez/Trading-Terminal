type BinanceCooldown = { status: number; retryAt: number };

// Public prices and account reads share Binance's outgoing-IP allowance.
let cooldown: BinanceCooldown | null = null;

export function getBinanceCooldown(): BinanceCooldown | null {
  return cooldown && Date.now() < cooldown.retryAt ? cooldown : null;
}

export function recordBinanceCooldown(
  status: number,
  retryAfter: string | null,
  message: string,
): BinanceCooldown {
  const now = Date.now();
  const seconds = retryAfter?.trim() ? Number(retryAfter) : Number.NaN;
  const headerDeadline = Number.isFinite(seconds)
    ? now + Math.max(0, seconds) * 1000
    : retryAfter
      ? Date.parse(retryAfter)
      : Number.NaN;
  const bannedUntil = Number(message.match(/banned until (\d{13})\b/i)?.[1]);
  const deadlines = [headerDeadline, bannedUntil].filter(
    (deadline) => Number.isFinite(deadline) && deadline > now,
  );
  const retryAt = deadlines.length
    ? Math.max(...deadlines)
    : now + (status === 418 ? 120_000 : 60_000);
  if (!cooldown || cooldown.retryAt < retryAt) cooldown = { status, retryAt };
  return cooldown;
}
