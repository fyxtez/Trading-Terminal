import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTradingStream } from "./useTradingStream";

vi.mock("../desktop/credentials", () => ({ canUseTradingAccount: () => true }));
vi.mock("../trading/events", () => ({
  getAuthenticatedTradingWebSocketUrl: vi.fn(async () => "ws://127.0.0.1/test"),
  parseTradingStreamEvent: vi.fn(),
}));

class TestSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: TestSocket[] = [];
  readyState = TestSocket.CONNECTING;
  close = vi.fn(() => {
    this.readyState = TestSocket.CLOSED;
  });
  constructor() {
    super();
    TestSocket.instances.push(this);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  TestSocket.instances = [];
});
describe("trading stream cleanup", () => {
  it.each([TestSocket.CONNECTING, TestSocket.OPEN])(
    "closes a socket in state %s on unmount",
    async (state) => {
      vi.useFakeTimers();
      vi.stubGlobal("WebSocket", TestSocket);
      const hook = renderHook(() => useTradingStream({ enabled: true, onOrderExecuted: vi.fn() }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      const socket = TestSocket.instances[0];
      expect(socket).toBeDefined();
      socket.readyState = state;
      hook.unmount();
      expect(socket.close).toHaveBeenCalledTimes(1);
      socket.dispatchEvent(new Event("close"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(TestSocket.instances).toHaveLength(1);
    },
  );
});
