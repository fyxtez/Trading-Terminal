import terminalMark from "../../assets/fyxtez-f-mark-alpha.png?inline";
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
import { userFacingError } from "../../utils/userFacingError";
import {
  getLocalBrowserSession,
  getTradingRuntimeMode,
  LOCAL_BROWSER_SESSION_CHANGED_EVENT,
  type LocalBrowserSession,
  type TradingRuntimeMode,
} from "../../config/constants";

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
      "Connect Binance to view your account and place orders. You can also skip this and use charts only.",
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
  const runtimeMode: TradingRuntimeMode = desktop ? "native" : getTradingRuntimeMode();
  const initialBrowserSession = !desktop ? getLocalBrowserSession() : null;
  const [status, setStatus] = useState<DesktopCredentialStatus>(() =>
    initialBrowserSession
      ? {
          ...emptyStatus,
          binanceConfigured: initialBrowserSession.binanceConfigured,
          binanceNetwork: initialBrowserSession.binanceNetwork,
        }
      : emptyStatus,
  );
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
        // Secrets remain intentionally blank; the matching venue renders a
        // visual mask without ever reading them back from protected storage.
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
        setError(userFacingError(reason, "Terminal could not check your saved connections."));
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
    if (runtimeMode !== "local-browser") {
      if (!desktop) setDesktopCredentialStatus(emptyStatus);
      return;
    }

    const applySession = (session: LocalBrowserSession | null) => {
      const next: DesktopCredentialStatus = session
        ? {
            ...emptyStatus,
            binanceConfigured: session.binanceConfigured,
            binanceNetwork: session.binanceNetwork,
          }
        : emptyStatus;
      setStatus(next);
      setDesktopCredentialStatus(next);
    };
    applySession(getLocalBrowserSession());
    const handleSession = (event: Event) =>
      applySession((event as CustomEvent<LocalBrowserSession | null>).detail);
    window.addEventListener(LOCAL_BROWSER_SESSION_CHANGED_EVENT, handleSession);
    return () => window.removeEventListener(LOCAL_BROWSER_SESSION_CHANGED_EVENT, handleSession);
  }, [desktop, runtimeMode]);

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
    () => ({
      isDesktop: desktop,
      runtimeMode,
      canTrade:
        (runtimeMode === "native" || runtimeMode === "local-browser") && status.binanceConfigured,
      status,
      openSetup,
      disconnectBinance,
    }),
    [desktop, disconnectBinance, openSetup, runtimeMode, status],
  );

  function setValue<K extends keyof ReturnType<typeof emptyValues>>(
    name: K,
    value: ReturnType<typeof emptyValues>[K],
  ) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  function selectBinanceNetwork(network: "mainnet" | "testnet") {
    setError(null);
    setValues((current) => {
      if (current.binanceNetwork === network) return current;
      const switchingBetweenNetworks = current.binanceNetwork !== "";
      return {
        ...current,
        binanceNetwork: network,
        // Choosing the first venue after pasting a new pair is harmless, but
        // never carry a pair from one concrete venue into the other.
        binanceApiKey: switchingBetweenNetworks ? "" : current.binanceApiKey,
        binanceApiSecret: switchingBetweenNetworks ? "" : current.binanceApiSecret,
        confirmMainnet: false,
      };
    });
  }

  const finish = (skipCurrentStep = false) => {
    setSaving(true);
    setError(null);
    const skipBinance = skipCurrentStep && activeStep?.key === "binance";
    const skipNtfy = skipCurrentStep && activeStep?.key === "ntfy";
    const skipTelegram = skipCurrentStep && activeStep?.key === "telegram";
    void invoke<DesktopCredentialStatus>("save_credentials", {
      input: {
        binanceApiKey: skipBinance ? null : values.binanceApiKey.trim() || null,
        binanceApiSecret: skipBinance ? null : values.binanceApiSecret.trim() || null,
        binanceNetwork: skipBinance ? null : values.binanceNetwork || null,
        confirmMainnet: skipBinance ? false : values.confirmMainnet,
        ntfyUrl: skipNtfy ? null : values.ntfyUrl.trim() || null,
        telegramBotToken: skipTelegram ? null : values.telegramBotToken.trim() || null,
        telegramChatId: skipTelegram ? null : values.telegramChatId.trim() || null,
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
        setError(userFacingError(reason, "Terminal could not save this connection.")),
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
        setError(userFacingError(reason, "Terminal could not check your saved connections."));
        setCredentialStatusFailed(true);
      })
      .finally(() => setSaving(false));
  };

  const next = () => {
    const binanceApiKey = values.binanceApiKey.trim();
    const binanceApiSecret = values.binanceApiSecret.trim();
    if (activeStep?.key === "binance" && !binanceApiKey && !binanceApiSecret) {
      setError("Enter both Binance fields, or choose Skip.");
      return;
    }
    if (activeStep?.key === "binance" && Boolean(binanceApiKey) !== Boolean(binanceApiSecret)) {
      setError("Enter both Binance fields, or skip this step.");
      return;
    }
    if (activeStep?.key === "binance" && binanceApiKey && !values.binanceNetwork) {
      setError("Choose real or practice trading.");
      return;
    }
    if (
      activeStep?.key === "binance" &&
      values.binanceNetwork === "mainnet" &&
      !values.confirmMainnet
    ) {
      setError("Confirm that real trading uses real funds.");
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
    else finish(true);
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
  const selectedBinanceCredentialsStored =
    activeStep?.key === "binance" &&
    status.binanceConfigured &&
    status.binanceNetwork === values.binanceNetwork;
  const binanceCredentialPlaceholder = selectedBinanceCredentialsStored ? "***" : undefined;
  const credentialReplacementReady =
    values.binanceApiKey.trim().length > 0 &&
    values.binanceApiSecret.trim().length > 0 &&
    values.binanceNetwork !== "" &&
    (values.binanceNetwork !== "mainnet" || values.confirmMainnet);

  const wizard = showSetup && activeStep && (
    <main className="desktop-setup">
      <section className={`desktop-setup-card ${activeSteps.length === 1 ? "single-step" : ""}`}>
        <header className="desktop-setup-header">
          <img src={terminalMark} alt="" />
          <div>
            <small>ACCOUNT SETUP</small>
            <h1>
              {editingSingleConnection
                ? `${configured ? "Edit" : "Connect"} ${activeStep.short.toLowerCase()}`
                : "Set up your terminal"}
            </h1>
            <p>Binance is optional. Change this connection later in Settings.</p>
          </div>
        </header>

        {activeSteps.length > 1 && (
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
        )}

        <div className="desktop-setup-body">
          <div className="desktop-setup-step-copy">
            {activeSteps.length > 1 && (
              <span>
                STEP {stepNumber} OF {stepCount}
              </span>
            )}
            <h2>{activeStep.title}</h2>
            <p>{activeStep.description}</p>
            {configured && <em>Already configured. Saving new values replaces this connection.</em>}
          </div>

          {activeStep.key === "binance" && (
            <div className="desktop-setup-fields">
              <aside>
                <strong>Use separate keys for Terminal</strong>
                <span>
                  Allow Futures trading, never withdrawals. Add an IP restriction if you can.
                </span>
              </aside>
              <fieldset className="desktop-network-picker">
                <legend>Choose how to trade</legend>
                <div role="radiogroup" aria-label="Choose how to trade">
                  <button
                    type="button"
                    className={values.binanceNetwork === "mainnet" ? "selected danger" : ""}
                    aria-pressed={values.binanceNetwork === "mainnet"}
                    onClick={() => selectBinanceNetwork("mainnet")}
                  >
                    <strong>LIVE</strong>
                    <span>Binance Mainnet · real funds</span>
                  </button>
                  <button
                    type="button"
                    className={values.binanceNetwork === "testnet" ? "selected" : ""}
                    aria-pressed={values.binanceNetwork === "testnet"}
                    onClick={() => selectBinanceNetwork("testnet")}
                  >
                    <strong>PRACTICE</strong>
                    <span>Binance Testnet · test funds</span>
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
                API key from Binance
                <input
                  value={values.binanceApiKey}
                  onChange={(event) => setValue("binanceApiKey", event.target.value)}
                  autoComplete="off"
                  placeholder={binanceCredentialPlaceholder}
                />
              </label>
              <label>
                Secret key from Binance
                <input
                  value={values.binanceApiSecret}
                  onChange={(event) => setValue("binanceApiSecret", event.target.value)}
                  type="password"
                  autoComplete="new-password"
                  placeholder={binanceCredentialPlaceholder}
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
          <span>Your Binance keys stay protected on this device.</span>
          <div>
            {credentialStatusFailed && (
              <button
                className="skip"
                type="button"
                disabled={saving}
                onClick={retryCredentialStatus}
              >
                TRY SAVED CONNECTIONS AGAIN
              </button>
            )}
            {!editingSingleConnection && (
              <button className="skip" type="button" disabled={saving} onClick={skip}>
                {isLastStep ? "SKIP" : "SKIP STEP"}
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
                  ? "CHECKING…"
                  : "SAVE NEW KEYS"
                : saving
                  ? "CHECKING…"
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
              label="Checking saved connections"
              detail="Looking for Binance accounts already connected on this device."
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
