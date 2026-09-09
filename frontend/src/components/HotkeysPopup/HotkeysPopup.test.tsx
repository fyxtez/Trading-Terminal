import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import HotkeysPopup from "./HotkeysPopup";

it("renders shortcuts and closes without crashing", () => {
  const onClose = vi.fn();
  render(<HotkeysPopup onClose={onClose} />);
  expect(screen.getByText("Keyboard shortcuts")).toBeInTheDocument();
  expect(screen.getByText("Double-click divider")).toBeInTheDocument();
  fireEvent.click(screen.getByTitle("Close"));
  expect(onClose).toHaveBeenCalledOnce();
});
