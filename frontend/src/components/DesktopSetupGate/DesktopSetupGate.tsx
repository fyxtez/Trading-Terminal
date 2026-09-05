import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  DESKTOP_ONBOARDING_KEY,
  DESKTOP_SETUP_EVENT,
  setDesktopCredentialStatus,
  type DesktopConnection,
  type DesktopCredentialStatus,
} from "../../desktop/credentials";
import { DesktopCredentialsContext } from "./DesktopCredentialsContext";
import LoadingIndicator from "../LoadingIndicator/LoadingIndicator";
import "./DesktopSetupGate.css";
import "./DesktopSetupGate.layout.css";
import { useAndroidBackNavigation } from "../../hooks/useAndroidBackNavigation";
import { EXTERNAL_NOTIFICATION_CONNECTIONS_ENABLED } from "../../config/features";

const emptyStatus: DesktopCredentialStatus = {
  binanceConfigured: false,
  binanceNetwork: null,
  ntfyConfigured: false,
  telegramConfigured: false,
};

const emptyValues = () => ({
  binanceApiKey: "",
  binanceApiSecret: "",
  binanceNetwork: "" as "" | "mainnet" | "testnet",
  confirmMainnet: false,
  ntfyUrl: "",
  telegramBotToken: "",
  telegramChatId: "",
});

function isValidNtfyDestination(value: string): boolean {
  value = value.trim();
  if (/^[-_A-Za-z0-9]{1,64}$/.test(value)) return true;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname)
    );
  } catch {
    return false;
  }
}

const allSteps = [
  {
    key: "binance",
    statusKey: "binanceConfigured",
    short: "BINANCE",
    title: "Connect Binance",
    description:
      "Connect a dedicated Binance API key to enable balances, positions and real order execution. Charting and drawing tools work without it.",
  },
  {
    key: "ntfy",
    statusKey: "ntfyConfigured",
    short: "NTFY",
    title: "Connect ntfy",
    description:
      "Optionally send price and trade notifications to another device through your private ntfy.sh topic.",
  },
  {
    key: "telegram",
    statusKey: "telegramConfigured",
    short: "TELEGRAM",
    title: "Connect Telegram",
    description:
      "Optionally deliver notifications through your own Telegram bot and private chat ID.",
  },
] as const satisfies ReadonlyArray<{
  key: DesktopConnection;
  statusKey: keyof DesktopCredentialStatus;
  short: string;
  title: string;
  description: string;
}>;

const steps = allSteps.filter(
  (item) => item.key === "binance" || EXTERNAL_NOTIFICATION_CONNECTIONS_ENABLED,
);

export default function DesktopSetupGate({ children }: { children: ReactNode }) {
  const desktop = isTauri();
  const [status, setStatus] = useState<DesktopCredentialStatus>(emptyStatus);
  const [loaded, setLoaded] = useState(!desktop);
  const [showSetup, setShowSetup] = useState(
    () => desktop && localStorage.getItem(DESKTOP_ONBOARDING_KEY) !== "true",
  );
  const [targetConnection, setTargetConnection] = useState<DesktopConnection | null>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [credentialStatusFailed, setCredentialStatusFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [values, setValues] = useState(emptyValues);
  const onboardingComplete = !desktop || localStorage.getItem(DESKTOP_ONBOARDING_KEY) === "true";

  const activeSteps = useMemo(
    () =>
      targetConnection
        ? steps.filter((item) => item.key === targetConnection)
        : steps.filter((item) => !status[item.statusKey]),
    [status, targetConnection],
  );
  const activeStep = activeSteps[step] ?? null;
  const isLastStep = step === activeSteps.length - 1;
  const editingSingleConnection = targetConnection !== null;

  const openSetup = useCallback(
    (connection?: DesktopConnection) => {
      setTargetConnection(connection ?? null);
      setStep(0);
      setValues({
        ...emptyValues(),
        // Editing Binance should show the currently active venue immediately.
        // Secrets remain intentionally blank and must be entered again.
        binanceNetwork: connection === "binance" ? (status.binanceNetwork ?? "") : "",
      });
      setError(null);
      setCredentialStatusFailed(false);
      setShowSetup(true);
    },
    [status.binanceNetwork],
  );

  const disconnectBinance = useCallback(async () => {
    const disconnectedStatus: DesktopCredentialStatus = {
      ...status,
      binanceConfigured: false,
      binanceNetwork: null,
    };
    // Block account actions as soon as the confirmed disconnect starts. If the
    // native transaction fails, re-read the keyring instead of guessing whether
    // its rollback restored the previous connection.
    setStatus(disconnectedStatus);
    setDesktopCredentialStatus(disconnectedStatus);

    try {
      const next = await invoke<DesktopCredentialStatus>("disconnect_binance");
      setStatus(next);
      setDesktopCredentialStatus(next);
    } catch (reason) {
      try {
        const recovered = await invoke<DesktopCredentialStatus>("credential_status");
        setStatus(recovered);
        setDesktopCredentialStatus(recovered);
      } catch {
        setStatus(emptyStatus);
        setDesktopCredentialStatus(emptyStatus);
      }
      throw reason;
    }
  }, [status]);

  useEffect(() => {
    if (!desktop) return;
    void invoke<DesktopCredentialStatus>("credential_status")
      .then((next) => {
        setCredentialStatusFailed(false);
        setStatus(next);
        setDesktopCredentialStatus(next);
      })
      .catch((reason: unknown) => {
        setStatus(emptyStatus);
        setDesktopCredentialStatus(emptyStatus);
        setError(reason instanceof Error ? reason.message : String(reason));
        setCredentialStatusFailed(true);
        // A locked, unavailable or incomplete credential store is not the same
        // as an unconfigured account. Keep trading disabled and open the styled
        // Binance editor so recovery guidance is visible even after onboarding.
        setTargetConnection("binance");
        setStep(0);
        setShowSetup(true);
      })
      .finally(() => setLoaded(true));
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    const open = () => openSetup();
    window.addEventListener(DESKTOP_SETUP_EVENT, open);
    return () => window.removeEventListener(DESKTOP_SETUP_EVENT, open);
  }, [desktop, openSetup]);

  useEffect(() => {
    if (!desktop || !loaded || !showSetup || targetConnection || activeSteps.length > 0) {
      return;
    }
    localStorage.setItem(DESKTOP_ONBOARDING_KEY, "true");
    setShowSetup(false);
  }, [activeSteps.length, desktop, loaded, showSetup, targetConnection]);

  const context = useMemo(
    () => ({ isDesktop: desktop, status, openSetup, disconnectBinance }),
    [desktop, disconnectBinance, openSetup, status],
  );

  function setValue<K extends keyof ReturnType<typeof emptyValues>>(
    name: K,
    value: ReturnType<typeof emptyValues>[K],
  ) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  const finish = () => {
    setSaving(true);
    setError(null);
    void invoke<DesktopCredentialStatus>("save_credentials", {
      input: {
        binanceApiKey: values.binanceApiKey.trim() || null,
        binanceApiSecret: values.binanceApiSecret.trim() || null,
        binanceNetwork: values.binanceNetwork || null,
        confirmMainnet: values.confirmMainnet,
        ntfyUrl: values.ntfyUrl.trim() || null,
        telegramBotToken: values.telegramBotToken.trim() || null,
        telegramChatId: values.telegramChatId.trim() || null,
      },
    })
      .then((next) => {
        setStatus(next);
        setDesktopCredentialStatus(next);
        localStorage.setItem(DESKTOP_ONBOARDING_KEY, "true");
        setValues(emptyValues());
        setShowSetup(false);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setSaving(false));
  };

  const retryCredentialStatus = () => {
    setSaving(true);
    setError(null);
    void invoke<DesktopCredentialStatus>("credential_status")
      .then((next) => {
        setStatus(next);
        setDesktopCredentialStatus(next);
        setCredentialStatusFailed(false);
        setValues(emptyValues());
        setTargetConnection(null);
        setStep(0);
        setShowSetup(!onboardingComplete);
      })
      .catch((reason: unknown) => {
        setStatus(emptyStatus);
        setDesktopCredentialStatus(emptyStatus);
        setError(reason instanceof Error ? reason.message : String(reason));
        setCredentialStatusFailed(true);
      })
      .finally(() => setSaving(false));
  };

  const next = () => {
    if (
      activeStep?.key === "binance" &&
      Boolean(values.binanceApiKey) !== Boolean(values.binanceApiSecret)
    ) {
      setError("Enter both Binance fields, or skip this step.");
      return;
    }
    if (activeStep?.key === "binance" && values.binanceApiKey && !values.binanceNetwork) {
      setError("Choose Binance Mainnet or Testnet.");
      return;
    }
    if (
      activeStep?.key === "binance" &&
      values.binanceNetwork === "mainnet" &&
      !values.confirmMainnet
    ) {
      setError("Confirm that Mainnet orders use real funds.");
      return;
    }
    if (
      activeStep?.key === "telegram" &&
      Boolean(values.telegramBotToken) !== Boolean(values.telegramChatId)
    ) {
      setError("Enter both Telegram fields, or skip this step.");
      return;
    }
    if (activeStep?.key === "ntfy" && values.ntfyUrl && !isValidNtfyDestination(values.ntfyUrl)) {
      setError(
        "Enter an ntfy topic using letters, numbers, dashes or underscores, or a complete http(s) URL.",
      );
      return;
    }
    setError(null);
    if (!isLastStep) setStep((current) => current + 1);
    else finish();
  };

  const skip = () => {
    setError(null);
    if (!isLastStep) setStep((current) => current + 1);
    else finish();
  };

  const closeSetup = () => {
    setError(null);
    setValues(emptyValues());
    setShowSetup(false);
  };

  const exitArmed = useAndroidBackNavigation(() => {
    if (!showSetup) return false;
    if (saving) return true;

    if (!editingSingleConnection && step > 0) {
      setError(null);
      setStep((current) => current - 1);
      return true;
    }

    if (onboardingComplete || editingSingleConnection) {
      closeSetup();
      return true;
    }

    return false;
  });

  const exitHint = exitArmed && (
    <div className="android-back-exit-hint" role="status">
      Press back again to exit
    </div>
  );

  const stepNumber = String(step + 1).padStart(2, "0");
  const stepCount = String(activeSteps.length).padStart(2, "0");
  const configured = activeStep ? status[activeStep.statusKey] : false;
  const credentialReplacementReady =
    values.binanceApiKey.trim().length > 0 &&
    values.binanceApiSecret.trim().length > 0 &&
    values.binanceNetwork !== "" &&
    (values.binanceNetwork !== "mainnet" || values.confirmMainnet);

  const wizard = showSetup && activeStep && (
    <main className="desktop-setup">
      <section className="desktop-setup-card">
        <header className="desktop-setup-header">
          <img src="/fyxtez-f-mark-alpha.png" alt="" />
          <div>
            <small>LOCAL APP SETUP</small>
            <h1>
              {editingSingleConnection
                ? `${configured ? "Edit" : "Connect"} ${activeStep.short.toLowerCase()}`
                : "Set up your terminal"}
            </h1>
            <p>Binance is optional. Change this connection later in Settings.</p>
          </div>
        </header>

        <nav
          className="desktop-setup-steps"
          aria-label="Setup progress"
          style={{
            gridTemplateColumns: `repeat(${activeSteps.length}, minmax(0, 1fr))`,
          }}
        >
          {activeSteps.map((item, index) => (
            <div
              className={`${index === step ? "active" : ""} ${index < step ? "done" : ""}`}
              key={item.short}
            >
              <b>{index < step ? "✓" : String(index + 1).padStart(2, "0")}</b>
              <span>{item.short}</span>
            </div>
          ))}
        </nav>

        <div className="desktop-setup-body">
          <div className="desktop-setup-step-copy">
            <span>
              STEP {stepNumber} OF {stepCount}
            </span>
            <h2>{activeStep.title}</h2>
            <p>{activeStep.description}</p>
            {configured && <em>Already configured. Saving new values replaces this connection.</em>}
          </div>

          {activeStep.key === "binance" && (
            <div className="desktop-setup-fields">
              <aside>
                <strong>Use a dedicated API key</strong>
                <span>
                  Enable Futures trading only if needed. Never enable withdrawals. Prefer an IP
                  restriction when practical.
                </span>
              </aside>
              <fieldset className="desktop-network-picker">
                <legend>Binance environment</legend>
                <div role="radiogroup" aria-label="Binance environment">
                  <button
                    type="button"
                    className={values.binanceNetwork === "mainnet" ? "selected danger" : ""}
                    aria-pressed={values.binanceNetwork === "mainnet"}
                    onClick={() => {
                      setValue("binanceNetwork", "mainnet");
                      setValue("confirmMainnet", false);
                    }}
                  >
                    <strong>MAINNET</strong>
                    <span>Real funds and real orders</span>
                  </button>
                  <button
                    type="button"
                    className={values.binanceNetwork === "testnet" ? "selected" : ""}
                    aria-pressed={values.binanceNetwork === "testnet"}
                    onClick={() => {
                      setValue("binanceNetwork", "testnet");
                      setValue("confirmMainnet", false);
                    }}
                  >
                    <strong>TESTNET</strong>
                    <span>Test funds and test orders</span>
                  </button>
                </div>
              </fieldset>
              {values.binanceNetwork === "mainnet" && (
                <label className="desktop-mainnet-confirmation">
                  <input
                    type="checkbox"
                    checked={values.confirmMainnet}
                    onChange={(event) => setValue("confirmMainnet", event.target.checked)}
                  />
                  <span>I understand that this connection can use real funds.</span>
                </label>
              )}
              <label>
                Binance API key
                <input
                  value={values.binanceApiKey}
                  onChange={(event) => setValue("binanceApiKey", event.target.value)}
                  autoComplete="off"
                />
              </label>
              <label>
                Binance API secret
                <input
                  value={values.binanceApiSecret}
                  onChange={(event) => setValue("binanceApiSecret", event.target.value)}
                  type="password"
                  autoComplete="new-password"
                />
              </label>
            </div>
          )}

          {activeStep.key === "ntfy" && (
            <div className="desktop-setup-fields">
              <aside>
                <strong>What is ntfy?</strong>
                <span>
                  Enter the topic name you subscribed to in ntfy. The app adds https://ntfy.sh/
                  automatically. Use a long, hard-to-guess name because anyone who knows an
                  unprotected topic can receive its messages.
                </span>
              </aside>
              <label>
                Private ntfy topic
                <input
                  value={values.ntfyUrl}
                  onChange={(event) => setValue("ntfyUrl", event.target.value)}
                  type="text"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="your-private-topic"
                />
              </label>
            </div>
          )}

          {activeStep.key === "telegram" && (
            <div className="desktop-setup-fields">
              <aside>
                <strong>Use your own Telegram bot</strong>
                <span>
                  Create a bot through BotFather, then enter its token and the chat ID that should
                  receive terminal notifications.
                </span>
              </aside>
              <label>
                Telegram bot token
                <input
                  value={values.telegramBotToken}
                  onChange={(event) => setValue("telegramBotToken", event.target.value)}
                  type="password"
                  autoComplete="new-password"
                />
              </label>
              <label>
                Telegram chat ID
                <input
                  value={values.telegramChatId}
                  onChange={(event) => setValue("telegramChatId", event.target.value)}
                  autoComplete="off"
                />
              </label>
            </div>
          )}

          {error && <div className="desktop-setup-error">{error}</div>}
        </div>

        <footer className="desktop-setup-actions">
          {step > 0 && !editingSingleConnection ? (
            <button
              className="secondary"
              type="button"
              disabled={saving}
              onClick={() => setStep((current) => current - 1)}
            >
              BACK
            </button>
          ) : onboardingComplete || editingSingleConnection ? (
            <button className="secondary" type="button" disabled={saving} onClick={closeSetup}>
              CLOSE
            </button>
          ) : (
            <i />
          )}
          <span>Secrets stay in your device credential manager.</span>
          <div>
            {credentialStatusFailed && (
              <button
                className="skip"
                type="button"
                disabled={saving}
                onClick={retryCredentialStatus}
              >
                RETRY CREDENTIAL STORE
              </button>
            )}
            {!editingSingleConnection && (
              <button className="skip" type="button" disabled={saving} onClick={skip}>
                {isLastStep ? "SKIP & FINISH" : "SKIP STEP"}
              </button>
            )}
            <button
              className="primary"
              type="button"
              disabled={saving || (credentialStatusFailed && !credentialReplacementReady)}
              onClick={next}
            >
              {credentialStatusFailed
                ? saving
                  ? "SAVING…"
                  : "SAVE REPLACEMENT"
                : saving
                  ? "SAVING…"
                  : editingSingleConnection
                    ? "SAVE"
                    : isLastStep
                      ? "FINISH"
                      : "NEXT"}
            </button>
          </div>
        </footer>
      </section>
    </main>
  );

  if (desktop && !loaded) {
    return (
      <>
        <main className="desktop-setup">
          <div className="desktop-setup-loading">
            <LoadingIndicator
              variant="panel"
              label="Opening credential store"
              detail="Reading connection status securely from this device."
            />
          </div>
        </main>
        {exitHint}
      </>
    );
  }

  const firstRun = desktop && !onboardingComplete;
  return (
    <DesktopCredentialsContext.Provider value={context}>
      {firstRun && showSetup ? (
        wizard
      ) : (
        <>
          {children}
          {wizard}
        </>
      )}
      {exitHint}
    </DesktopCredentialsContext.Provider>
  );
}
