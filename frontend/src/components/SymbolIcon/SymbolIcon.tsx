import { useEffect, useMemo, useState } from "react";
import { getSymbolInfo } from "../../config/symbols";
import "./SymbolIcon.css";

type SymbolIconProps = {
  symbol: string;
  className?: string;
};

/**
 * Uses our bundled icon first, then verified runtime exchange metadata.
 * Unknown assets get a neutral token glyph instead of guessing a logo from
 * the ticker (which can easily resolve to the wrong project).
 */
export default function SymbolIcon({ symbol, className = "" }: SymbolIconProps) {
  const info = getSymbolInfo(symbol);
  const candidates = useMemo(
    // do not guess MEXC artwork from the ticker because unrelated tokens
    // can share a symbol. Only bundled, backend-verified, or explicitly mapped
    // assets from config/symbols.ts are accepted before the neutral fallback.
    () => Array.from(new Set([info.icon].filter(Boolean) as string[])),
    [info.icon],
  );
  const [candidateIndex, setCandidateIndex] = useState(0);

  useEffect(() => setCandidateIndex(0), [symbol, info.icon]);

  const src = candidates[candidateIndex];
  if (!src) {
    return (
      <span className={`symbol-token-fallback ${className}`.trim()} aria-hidden="true">
        <svg viewBox="0 0 18 18" focusable="false">
          <circle cx="9" cy="9" r="6.25" />
          <path d="M9 5.3 12.7 9 9 12.7 5.3 9 9 5.3Z" />
        </svg>
      </span>
    );
  }

  return (
    <img
      className={`symbol-token-icon ${className}`.trim()}
      src={src}
      alt=""
      aria-hidden="true"
      referrerPolicy="no-referrer"
      onError={() => setCandidateIndex((index) => index + 1)}
    />
  );
}
