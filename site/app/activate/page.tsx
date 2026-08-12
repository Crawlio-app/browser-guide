"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "browser-guide:activationStep";

type StepStatus = "complete" | "active" | "pending";

const STEPS = [
  { label: "Install the extension", detail: "Loaded and running in Chrome." },
  { label: "Allow the local helper", detail: "Chrome can reach the Keychain helper on this Mac." },
  { label: "Take your first tour", detail: "Open any page, click the Browser Guide icon, choose Walkthrough." },
];

function CrawlioLogo() {
  return (
    <svg width="44" height="34" viewBox="0 0 324 250" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M67.5441 55.8643C47.4515 61.2723 32.6209 46.2677 17 61.8887C1.379 77.5097 10.5521 93.6713 10.9755 112.433L130.415 234.573C142.709 246.867 161.65 237.78 177.271 222.159C192.892 206.539 195.589 183.909 183.295 171.615L67.5441 55.8643Z" fill="#FF5524" />
      <path d="M201.527 39.882C201.527 20.801 189.396 1.1473 161.18 0C141.632 0 123.896 13.6579 121.527 39.3971L120.818 199.161C120.752 214.037 124.964 229.255 136.849 238.2C143.761 243.402 152.354 247.851 161.527 247.851C177.231 247.851 185.084 240.612 192.391 229.162C198.846 219.046 201.527 206.998 201.527 194.998V39.882Z" fill="#8337FF" />
      <path d="M310.364 116.84C323.541 103.664 325.88 79.6389 308.354 62.1132C292.78 46.5387 268.037 46.0305 254.861 59.2068L132.235 181.832C119.059 195.008 121.003 218.316 136.578 233.89C152.152 249.465 175.459 251.409 188.636 238.232L310.364 116.84Z" fill="#2EB6FF" />
      <path d="M161.527 249.248C183.918 249.248 202.069 231.097 202.069 208.706C202.069 186.315 183.918 168.163 161.527 168.163C139.136 168.163 120.984 186.315 120.984 208.706C120.984 231.097 139.136 249.248 161.527 249.248Z" fill="#ABFF50" />
      <path d="M161.527 80C183.619 80 201.527 62.0914 201.527 40C201.527 17.9086 183.619 0 161.527 0C139.436 0 121.527 17.9086 121.527 40C121.527 62.0914 139.436 80 161.527 80Z" fill="#9C60FF" />
      <path d="M283.283 127.292C305.375 127.292 323.283 109.383 323.283 87.292C323.283 65.2006 305.375 47.292 283.283 47.292C261.192 47.292 243.283 65.2006 243.283 87.292C243.283 109.383 261.192 127.292 283.283 127.292Z" fill="#58C5FF" />
      <path d="M40 124.893C62.0914 124.893 80 106.984 80 84.8926C80 62.8012 62.0914 44.8926 40 44.8926C17.9086 44.8926 0 62.8012 0 84.8926C0 106.984 17.9086 124.893 40 124.893Z" fill="#FF7750" />
    </svg>
  );
}

function StepDot({ status }: { status: StepStatus }) {
  if (status === "complete") {
    return (
      <span className="act-dot complete" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="act-dot active" aria-hidden="true">
        <span />
      </span>
    );
  }
  return <span className="act-dot" aria-hidden="true" />;
}

export default function ActivatePage() {
  const [currentStep, setCurrentStep] = useState(3);
  const [allDone, setAllDone] = useState(false);
  const [mounted, setMounted] = useState(false);
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    const fromExtension = params.get("from") === "extension";
    if (fromExtension) {
      window.history.replaceState({}, "", window.location.pathname);
    }
    queueMicrotask(() => {
      if (cancelled) return;
      if (fromExtension) {
        // The wizard only hands off here after the helper permission is
        // granted, so arriving from the extension means steps 1-2 are done.
        setCurrentStep(3);
        localStorage.setItem(STORAGE_KEY, "3");
      } else {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const step = parseInt(saved, 10);
          if (step > 3) {
            setAllDone(true);
            setCurrentStep(4);
          } else if (step >= 3) {
            setCurrentStep(step);
          }
        }
      }
      setMounted(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!allDone) return;
    redirectTimer.current = setTimeout(() => {
      window.location.href = "/";
    }, 3000);
    return () => {
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
    };
  }, [allDone]);

  const finish = useCallback(() => {
    setAllDone(true);
    setCurrentStep(4);
    localStorage.setItem(STORAGE_KEY, "4");
  }, []);

  const getStatus = useCallback(
    (step: number): StepStatus => {
      if (allDone || step < currentStep) return "complete";
      if (step === currentStep) return "active";
      return "pending";
    },
    [currentStep, allDone],
  );

  if (!mounted) return null;

  return (
    <div className="act-shell">
      <div className="act-card">
        <div className="act-logo"><CrawlioLogo /></div>
        <h1>{allDone ? "You’re all set!" : "Browser Guide is connected"}</h1>
        <p className="act-subtitle">
          {allDone
            ? "Enjoy the guide — taking you to the docs."
            : "The read-only guide is ready. One thing left: take it for a spin."}
        </p>

        <ol className="act-steps">
          {STEPS.map((step, index) => {
            const status = getStatus(index + 1);
            return (
              <li key={step.label} className={`act-step ${status}`}>
                <StepDot status={status} />
                <div>
                  <span className="act-label">{step.label}</span>
                  <span className="act-detail">{step.detail}</span>
                </div>
              </li>
            );
          })}
        </ol>

        {!allDone && (
          <button type="button" className="act-action" onClick={finish}>
            I took my first tour
          </button>
        )}
        {!allDone && (
          <p className="act-hint">
            Tip: press the emerald beacon or <code>⌘⇧Space</code> to ask by voice.
          </p>
        )}
      </div>
      <p className="act-footer">
        <a href="/">Docs</a> · <a href="https://github.com/Crawlio-app/browser-guide">Open source</a> · by{" "}
        <a href="https://www.crawlio.app">Crawlio</a>
      </p>
    </div>
  );
}
