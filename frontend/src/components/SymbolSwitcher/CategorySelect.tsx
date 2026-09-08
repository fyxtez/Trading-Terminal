import { useEffect, useId, useRef, useState } from "react";
import {
  SYMBOL_CATEGORY_OPTIONS,
  type SymbolCategory,
  type EditableSymbolCategory,
} from "../../config/symbolCategories";
import { useFixedPopoverPosition } from "../../hooks/useFixedPopoverPosition";

export default function CategorySelect({
  value,
  label,
  onChange,
}: {
  value: SymbolCategory;
  label: string;
  onChange: (value: EditableSymbolCategory) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = useRef<HTMLDivElement>(null);
  const id = useId();
  const position = useFixedPopoverPosition(trigger, open, 190);

  useEffect(() => {
    if (!open) return;
    options.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", dismiss, true);
    return () => window.removeEventListener("pointerdown", dismiss, true);
  }, [open]);

  return (
    <div
      ref={root}
      className="symbol-category-picker"
      onClick={(event) => event.stopPropagation()}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="symbol-category-select"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {SYMBOL_CATEGORY_OPTIONS.find((option) => option.value === value)?.label}
      </button>
      {open && (
        <div
          ref={options}
          id={id}
          role="listbox"
          aria-label={label}
          className="symbol-category-options"
          style={{
            ...position,
            top: Math.max(8, Math.min(Number(position?.top ?? 8), window.innerHeight - 170)),
            maxHeight: Math.max(0, Math.min(160, window.innerHeight - 16)),
          }}
          onKeyDown={(event) => {
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
            );
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === "ArrowDown"
                ? (index + 1) % items.length
                : event.key === "ArrowUp"
                  ? (index - 1 + items.length) % items.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : null;
            if (next !== null) {
              event.preventDefault();
              event.stopPropagation();
              items[next]?.focus();
            }
          }}
        >
          {SYMBOL_CATEGORY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              tabIndex={-1}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
                onChange(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
