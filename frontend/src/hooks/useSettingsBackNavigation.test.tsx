import { StrictMode } from "react";
import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTauri } from "@tauri-apps/api/core";
import { MOBILE_BACK_EVENT, claimMobileBack } from "./useAndroidBackNavigation";
import { useSettingsBackNavigation } from "./useSettingsBackNavigation";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(), invoke: vi.fn() }));

afterEach(() => {
  history.replaceState(null, "");
  vi.useRealTimers();
});

describe("Settings Back navigation", () => {
  it("claims Android Back before the panel's general close handler", () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const closePanel = vi.fn();
    const parent = (event: Event) => claimMobileBack(event, closePanel);
    window.addEventListener(MOBILE_BACK_EVENT, parent);
    const back = vi.fn();
    const view = renderHook(() => useSettingsBackNavigation(true, back));
    act(() =>
      window.dispatchEvent(
        new CustomEvent(MOBILE_BACK_EVENT, { cancelable: true, detail: { handled: false } }),
      ),
    );
    expect(back).toHaveBeenCalledOnce();
    expect(closePanel).not.toHaveBeenCalled();
    view.unmount();
    window.removeEventListener(MOBILE_BACK_EVENT, parent);
  });

  it("handles native mouse Back once and leaves other buttons alone", () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const back = vi.fn();
    renderHook(() => useSettingsBackNavigation(true, back));
    fireEvent.mouseUp(window, { button: 0 });
    fireEvent.mouseUp(window, { button: 4 });
    expect(back).not.toHaveBeenCalled();
    fireEvent.mouseDown(window, { button: 3 });
    fireEvent.mouseUp(window, { button: 3 });
    fireEvent(window, new MouseEvent("auxclick", { button: 3 }));
    expect(back).toHaveBeenCalledOnce();
  });

  it("uses one browser history entry through StrictMode and consumes Back without another traversal", () => {
    vi.useFakeTimers();
    vi.mocked(isTauri).mockReturnValue(false);
    history.replaceState({ existing: true }, "");
    const push = vi.spyOn(history, "pushState");
    const traverse = vi.spyOn(history, "back").mockImplementation(() => {});
    const back = vi.fn();
    const view = renderHook(() => useSettingsBackNavigation(true, back), { wrapper: StrictMode });
    expect(push).toHaveBeenCalledTimes(1);
    expect(history.state.existing).toBe(true);
    act(() => {
      history.replaceState({ existing: true }, "");
      window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    });
    expect(back).toHaveBeenCalledOnce();
    view.unmount();
    act(() => vi.runAllTimers());
    expect(traverse).not.toHaveBeenCalled();
  });

  it("removes its browser entry when All settings or closing the panel deactivates it", () => {
    vi.useFakeTimers();
    vi.mocked(isTauri).mockReturnValue(false);
    const traverse = vi.spyOn(history, "back").mockImplementation(() => {});
    const back = vi.fn();
    const view = renderHook(({ active }) => useSettingsBackNavigation(active, back), {
      initialProps: { active: true },
    });
    view.rerender({ active: false });
    act(() => vi.runAllTimers());
    expect(traverse).toHaveBeenCalledOnce();
    expect(back).not.toHaveBeenCalled();
  });
});
