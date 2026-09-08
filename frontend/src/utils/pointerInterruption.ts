/** Cancel unfinished gestures when the browser stops delivering their normal pointer-up. */
export function watchPointerInterruption(cancel: () => void): () => void {
  const hidden = () => {
    if (document.hidden) cancel();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") cancel();
  };
  window.addEventListener("blur", cancel);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("lostpointercapture", cancel, true);
  window.addEventListener("keydown", key, true);
  document.addEventListener("visibilitychange", hidden);
  return () => {
    window.removeEventListener("blur", cancel);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("lostpointercapture", cancel, true);
    window.removeEventListener("keydown", key, true);
    document.removeEventListener("visibilitychange", hidden);
  };
}
