import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, CloseIcon, CompassIcon } from "./Icons";

export const TOUR_STORAGE_KEY = "reporeview_tour_seen";

export function hasSeenTour(): boolean {
  try {
    return window.localStorage.getItem(TOUR_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markTourSeen(): void {
  try {
    window.localStorage.setItem(TOUR_STORAGE_KEY, "1");
  } catch {
    // storage unavailable in restricted browsing modes
  }
}

interface TourStop {
  id: "session" | "vault" | "steps" | "signout";
  selector: string;
  eyebrow: string;
  title: string;
  body: string;
}

export const TOUR_STOPS: readonly TourStop[] = [
  {
    id: "session",
    selector: '[data-tour="session"]',
    eyebrow: "Zero-Secret Session",
    title: "Your browser cookie holds zero tokens",
    body: "GitHub OAuth or .env GITHUB_TOKEN handed your token directly to Gemini's Credentials API on sign-in. Your session cookie only stores a vault reference ID.",
  },
  {
    id: "vault",
    selector: '[data-tour="vault"]',
    eyebrow: "Write-Only Credential Vault",
    title: "Live GET /v1beta/credentials & allowlist",
    body: "Inspect the live drawer on the right: GET /v1beta/credentials returns metadata only (secret: never returned) alongside the sandbox egress proxy allowlist.",
  },
  {
    id: "steps",
    selector: '[data-tour="steps"]',
    eyebrow: "Remote MCP + Linux Sandbox",
    title: "One Managed Agent turn, two isolated tools",
    body: "RepoReview pairs GitHub MCP (structured PR metadata & diffs) with an isolated Ubuntu VM where the pr-review skill checks out untrusted PR branches and runs tests.",
  },
  {
    id: "signout",
    selector: '[data-tour="signout"]',
    eyebrow: "One-Click Teardown",
    title: "Sign-out revokes Vault & destroys the VM",
    body: "Clicking Sign Out calls credentials.delete and environments.delete on the server, immediately revoking GitHub access and tearing down the sandbox container.",
  },
];

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

interface GuidedTourProps {
  active: boolean;
  stepIndex: number;
  onStepChange: (nextIndex: number) => void;
  onClose: () => void;
}

export function GuidedTour({ active, stepIndex, onStepChange, onClose }: GuidedTourProps) {
  const ringRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const stop = TOUR_STOPS[stepIndex] ?? TOUR_STOPS[0]!;
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === TOUR_STOPS.length - 1;

  const positionElements = useCallback(() => {
    const ring = ringRef.current;
    const card = cardRef.current;
    if (!ring || !card) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardRect = card.getBoundingClientRect();
    const cardW = cardRect.width || Math.min(380, vw - 32);
    const cardH = cardRect.height || 230;

    const selector =
      stop.id === "vault" && document.querySelector(".drawer-panel") ? ".drawer-panel" : stop.selector;
    const target = document.querySelector<HTMLElement>(selector);
    const rect = target?.getBoundingClientRect();

    if (rect && rect.width > 0 && rect.height > 0) {
      const isDrawerTarget = selector === ".drawer-panel";
      const pad = isDrawerTarget ? 0 : 6;
      ring.style.opacity = "1";
      ring.style.top = `${Math.max(isDrawerTarget ? 0 : 4, rect.top - pad)}px`;
      ring.style.left = `${Math.max(isDrawerTarget ? 0 : 4, rect.left - pad)}px`;
      ring.style.width = `${Math.min(vw, rect.width + pad * 2)}px`;
      ring.style.height = `${Math.min(vh, rect.height + pad * 2)}px`;

      if (stop.id === "vault") {
        // VaultDrawer opens on the right (up to 620px wide). Keep the tour card unobstructed to its left!
        const drawerW = Math.min(620, vw * 0.92);
        if (vw - drawerW >= cardW + 40) {
          const left = clamp(vw - drawerW - cardW - 24, 16, vw - cardW - 16);
          const top = clamp(82, 76, vh - cardH - 16);
          card.style.left = `${left}px`;
          card.style.top = `${top}px`;
        } else {
          // Narrow screen: dock cleanly near bottom-left
          card.style.left = "16px";
          card.style.top = `${clamp(vh - cardH - 20, 72, vh - cardH - 16)}px`;
        }
        return;
      }

      if (stop.id === "steps") {
        // Place neatly above the suggestions/steps if room, otherwise anchored near top-left of target
        const spaceAbove = rect.top - 80;
        const top =
          spaceAbove >= cardH + 16
            ? rect.top - cardH - 16
            : clamp(rect.top + 16, 80, vh - cardH - 20);
        const left = clamp(rect.left + (rect.width - cardW) / 2, 16, vw - cardW - 16);
        card.style.left = `${left}px`;
        card.style.top = `${top}px`;
        return;
      }

      // Default (session / signout): anchor right below the TopBar pill
      const top = clamp(rect.bottom + 14, 72, vh - cardH - 16);
      const preferredLeft = stop.id === "signout" ? rect.right - cardW : rect.left;
      const left = clamp(preferredLeft, 16, vw - cardW - 16);
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
    } else {
      ring.style.opacity = "0";
      card.style.left = `${clamp((vw - cardW) / 2, 16, vw - cardW - 16)}px`;
      card.style.top = `${clamp((vh - cardH) / 2, 72, vh - cardH - 16)}px`;
    }
  }, [stop]);

  useLayoutEffect(() => {
    if (!active) return;
    positionElements();
    const raf = window.requestAnimationFrame(positionElements);
    const settleTimer = window.setTimeout(positionElements, 260);
    window.addEventListener("resize", positionElements);
    window.addEventListener("scroll", positionElements, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(settleTimer);
      window.removeEventListener("resize", positionElements);
      window.removeEventListener("scroll", positionElements, true);
    };
  }, [active, stepIndex, positionElements]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight" && !isLast) {
        e.preventDefault();
        onStepChange(stepIndex + 1);
      } else if (e.key === "ArrowLeft" && !isFirst) {
        e.preventDefault();
        onStepChange(stepIndex - 1);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, stepIndex, isFirst, isLast, onStepChange, onClose]);

  if (!active) return null;

  return (
    <div className="tour-layer" aria-live="polite">
      <div ref={ringRef} className="tour-ring" aria-hidden="true" />

      <section
        ref={cardRef}
        className="tour-card"
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-card-title"
      >
        <div className="tour-card-top">
          <span className="tour-step-pill">
            <CompassIcon size={14} />
            <span>
              {stepIndex + 1} of {TOUR_STOPS.length} · {stop.eyebrow}
            </span>
          </span>
          <button
            type="button"
            className="tour-close-btn"
            onClick={onClose}
            aria-label="Dismiss guided tour"
            title="Dismiss tour"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        <h3 id="tour-card-title" className="tour-title">
          {stop.title}
        </h3>
        <p className="tour-body">{stop.body}</p>

        <div className="tour-footer">
          <div className="tour-dots" role="tablist" aria-label="Tour steps">
            {TOUR_STOPS.map((s, idx) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={idx === stepIndex}
                aria-label={`Step ${idx + 1}: ${s.eyebrow}`}
                className={`tour-dot${idx === stepIndex ? " is-active" : ""}`}
                onClick={() => onStepChange(idx)}
              />
            ))}
          </div>

          <div className="tour-nav">
            {!isFirst && (
              <button
                type="button"
                className="tour-btn tour-btn-ghost"
                onClick={() => onStepChange(stepIndex - 1)}
              >
                <ArrowLeftIcon size={15} />
                <span>Back</span>
              </button>
            )}
            {isLast ? (
              <button type="button" className="tour-btn tour-btn-primary" onClick={onClose}>
                <CheckIcon size={15} />
                <span>Done</span>
              </button>
            ) : (
              <button
                type="button"
                className="tour-btn tour-btn-primary"
                onClick={() => onStepChange(stepIndex + 1)}
              >
                <span>Next</span>
                <ArrowRightIcon size={15} />
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
