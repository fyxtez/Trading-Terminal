import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { isRemoteBackend, TRADING_API_BASE_URL } from "../../config/constants";
import "./BackendConnectionSection.css";

export default function BackendConnectionSection() {
  const [mode, setMode] = useState(isRemoteBackend() ? "remote" : "local");
  const [url, setUrl] = useState(
    isRemoteBackend() ? TRADING_API_BASE_URL : "https://terminal.fyxtez.com",
  );
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    void invoke<{ mode: string; url?: string }>("backend_connection_settings")
      .then((profile) => {
        setMode(profile.mode);
        if (profile.url) setUrl(profile.url);
      })
      .catch(() => setError("Saved connection could not be read. Choose a connection below."));
  }, []);
  if (!isTauri()) return null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await invoke("save_backend_connection", {
        input: {
          mode,
          url: mode === "remote" ? url : null,
          token: mode === "remote" ? token : null,
        },
      });
      setToken("");
    } catch (reason) {
      setError(typeof reason === "string" ? reason : "Could not save the server connection.");
      setSaving(false);
    }
  };

  return (
    <section
      className="settings-section backend-connection-section"
      aria-label="Backend connection"
    >
      <h3>Backend connection</h3>
      <label>
        Run trading through
        <select value={mode} disabled={saving} onChange={(event) => setMode(event.target.value)}>
          <option value="local">Local — this device</option>
          <option value="remote">Private server</option>
        </select>
      </label>
      {mode === "remote" && (
        <>
          <label>
            Server URL
            <input
              type="url"
              value={url}
              disabled={saving}
              onChange={(event) => setUrl(event.target.value)}
              spellCheck={false}
              autoCapitalize="none"
            />
          </label>
          <label>
            Server access token
            <input
              type="password"
              value={token}
              disabled={saving}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Leave blank to use the saved token"
              autoComplete="off"
            />
          </label>
          <p>Binance keys stay on your server. This token connects this device to it.</p>
        </>
      )}
      <p>Saving restarts Terminal. A lost server connection reconnects to the same server.</p>
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={saving} onClick={() => void save()}>
        {saving ? "CONNECTING…" : "SAVE AND RESTART"}
      </button>
    </section>
  );
}
