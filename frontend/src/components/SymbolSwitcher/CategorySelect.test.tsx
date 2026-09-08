import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CategorySelect from "./CategorySelect";

describe("CategorySelect", () => {
  it("opens styled options and changes category with the keyboard", () => {
    const onChange = vi.fn();
    render(<CategorySelect value="altcoins" label="Category for MX" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "Category for MX" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Altcoins" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    const traditional = screen.getByRole("option", { name: "Traditional Markets" });
    expect(document.activeElement).toBe(traditional);
    fireEvent.click(traditional);
    expect(onChange).toHaveBeenCalledWith("traditional");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses without changing the category on Escape or an outside click", () => {
    const onChange = vi.fn();
    const parentEscape = vi.fn();
    render(
      <div onKeyDown={parentEscape}>
        <CategorySelect value="other" label="Category for MX" onChange={onChange} />
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "Category for MX" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("option", { name: "Other" }), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(parentEscape).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
