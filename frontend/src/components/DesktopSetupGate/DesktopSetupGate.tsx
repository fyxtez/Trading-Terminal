import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
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

const steps = [
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
      "Optionally send price and trade notifications to another device through your private ntfy topic URL.",
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

export default function DesktopSetupGate({ children }: { children: ReactNode }) {
  const desktop = isTauri();
  const [status, setStatus] = useState<DesktopCredentialStatus>(
    emptyStatus,
  );
  const [loaded, setLoaded] = useState(!desktop);
  const [showSetup, setShowSetup] = useState(
    () => desktop && localStorage.getItem(DESKTOP_ONBOARDING_KEY) !== "true",
  );
  const [targetConnection, setTargetConnection] =
    useState<DesktopConnection | null>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [values, setValues] = useState(emptyValues);
  const onboardingComplete =
    !desktop || localStorage.getItem(DESKTOP_ONBOARDING_KEY) === "true";

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

  const openSetup = useCallback((connection?: DesktopConnection) => {
    setTargetConnection(connection ?? null);
    setStep(0);
    setValues(emptyValues());
    setError(null);
    setShowSetup(true);
  }, []);

  useEffect(() => {
    if (!desktop) return;
    void invoke<DesktopCredentialStatus>("credential_status")
      .then((next) => {
        setStatus(next);
        setDesktopCredentialStatus(next);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setLoaded(true));

    const open = () => openSetup();
    window.addEventListener(DESKTOP_SETUP_EVENT, open);
    return () => window.removeEventListener(DESKTOP_SETUP_EVENT, open);
  }, [desktop, openSetup]);

  useEffect(() => {
    if (
      !desktop ||
      !loaded ||
      !showSetup ||
      targetConnection ||
      activeSteps.length > 0
    ) {
      return;
    }
    localStorage.setItem(DESKTOP_ONBOARDING_KEY, "true");
    setShowSetup(false);
  }, [activeSteps.length, desktop, loaded, showSetup, targetConnection]);

  const context = useMemo(
    () => ({ isDesktop: desktop, status, openSetup }),
    [desktop, openSetup, status],
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

  const next = () => {
    if (
      activeStep?.key === "binance" &&
      Boolean(values.binanceApiKey) !== Boolean(values.binanceApiSecret)
    ) {
      setError("Enter both Binance fields, or skip this step.");
      return;
    }
    if (
      activeStep?.key === "binance" &&
      values.binanceApiKey &&
      !values.binanceNetwork
    ) {
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

  const stepNumber = String(step + 1).padStart(2, "0");
  const stepCount = String(activeSteps.length).padStart(2, "0");
  const configured = activeStep ? status[activeStep.statusKey] : false;

  const wizard = showSetup && activeStep && (
    <main className="desktop-setup">
      <section className="desktop-setup-card">
        <header className="desktop-setup-header">
          <img src="/fyxtez-f-mark-alpha.png" alt="" />
          <div>
            <small>LOCAL DESKTOP SETUP</small>
            <h1>
              {editingSingleConnection
                ? `${configured ? "Edit" : "Connect"} ${activeStep.short.toLowerCase()}`
                : "Set up your terminal"}
            </h1>
            <p>Everything is optional. Change these connections later in Settings.</p>
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
              <b>
                {index < step
                  ? "✓"
                  : String(index + 1).padStart(2, "0")}
              </b>
              <span>{item.short}</span>
            </div>
          ))}
        </nav>

        <div className="desktop-setup-body">
          <div className="desktop-setup-step-copy">
            <span>STEP {stepNumber} OF {stepCount}</span>
            <h2>{activeStep.title}</h2>
            <p>{activeStep.description}</p>
            {configured && (
              <em>
                Already configured. Saving new values replaces this connection.
              </em>
            )}
          </div>

          {activeStep.key === "binance" && (
            <div className="desktop-setup-fields">
              <aside>
                <strong>Use a dedicated API key</strong>
                <span>
                  Enable Futures trading only if needed. Never enable withdrawals.
                  Prefer an IP restriction when practical.
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
                    onChange={(event) =>
                      setValue("confirmMainnet", event.target.checked)
                    }
                  />
                  <span>I understand that this connection can use real funds.</span>
                </label>
              )}
              <label>
                Binance API key
                <input
                  value={values.binanceApiKey}
                  onChange={(event) =>
                    setValue("binanceApiKey", event.target.value)
                  }
                  autoComplete="off"
                />
              </label>
              <label>
                Binance API secret
                <input
                  value={values.binanceApiSecret}
                  onChange={(event) =>
                    setValue("binanceApiSecret", event.target.value)
                  }
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
                  ntfy publishes notifications to a topic URL. Treat an
                  unprotected topic URL as private because anyone who knows it
                  may receive messages.
                </span>
              </aside>
              <label>
                Private ntfy publish URL
                <input
                  value={values.ntfyUrl}
                  onChange={(event) => setValue("ntfyUrl", event.target.value)}
                  type="url"
                  placeholder="https://ntfy.sh/your-private-topic"
                />
              </label>
            </div>
          )}

          {activeStep.key === "telegram" && (
            <div className="desktop-setup-fields">
              <aside>
                <strong>Use your own Telegram bot</strong>
                <span>
                  Create a bot through BotFather, then enter its token and the
                  chat ID that should receive terminal notifications.
                </span>
              </aside>
              <label>
                Telegram bot token
                <input
                  value={values.telegramBotToken}
                  onChange={(event) =>
                    setValue("telegramBotToken", event.target.value)
                  }
                  type="password"
                  autoComplete="new-password"
                />
              </label>
              <label>
                Telegram chat ID
                <input
                  value={values.telegramChatId}
                  onChange={(event) =>
                    setValue("telegramChatId", event.target.value)
                  }
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
            <button
              className="secondary"
              type="button"
              disabled={saving}
              onClick={closeSetup}
            >
              CLOSE
            </button>
          ) : (
            <i />
          )}
          <span>Secrets stay in your OS credential manager.</span>
          <div>
            {!editingSingleConnection && (
              <button
                className="skip"
                type="button"
                disabled={saving}
                onClick={skip}
              >
                {isLastStep ? "SKIP & FINISH" : "SKIP STEP"}
              </button>
            )}
            <button
              className="primary"
              type="button"
              disabled={saving}
              onClick={next}
            >
              {saving
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
      <main className="desktop-setup">
        <div className="desktop-setup-loading">
          <LoadingIndicator
            variant="panel"
            label="Opening credential store"
            detail="Reading connection status securely from this computer."
          />
        </div>
      </main>
    );
  }

  const firstRun = desktop && !onboardingComplete;
  return (
    <DesktopCredentialsContext.Provider value={context}>
      {firstRun && showSetup ? wizard : <>{children}{wizard}</>}
    </DesktopCredentialsContext.Provider>
  );
}
