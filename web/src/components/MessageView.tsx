import { memo, useEffect, useState } from "react";
import type { Message, Step, StepKind } from "../types";
import { CheckIcon, CopyIcon, ErrorIcon, ExpandIcon, RefreshIcon, StepKindIcon } from "./Icons";
import { Sparkle } from "./Logo";
import { MarkdownText } from "./Markdown";
import { tidyStreamingMarkdown } from "../markdownStream";

export const UserMessage = memo(function UserMessage({ text }: { text: string }) {
  return (
    <div className="msg msg-user">
      <div className="bubble">{text}</div>
    </div>
  );
});

function kindBadgeLabel(kind: StepKind): string {
  switch (kind) {
    case "mcp":
      return "GitHub MCP";
    case "code":
      return "Sandbox";
    case "tool":
      return "Tool";
    case "search":
      return "Google Search";
    case "thought":
      return "Reasoning";
    default:
      return "Tool";
  }
}

function stepsSummary(steps: Step[]): string {
  if (steps.length === 0) return "Completed";
  const kinds = new Set(steps.map((s) => s.kind));
  const parts: string[] = [];
  if (kinds.has("mcp")) parts.push("GitHub MCP");
  if (kinds.has("code")) parts.push("Linux Sandbox");
  if (kinds.has("tool")) parts.push("Tools");
  if (kinds.has("search")) parts.push("Google Search");
  const count = `${steps.length} step${steps.length === 1 ? "" : "s"}`;
  if (parts.length === 0) return `Reasoning · ${count}`;
  return `${parts.join(" + ")} · ${count}`;
}

function StepRow({ step }: { step: Step }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const stateLabel = step.state === "running" ? "Running" : step.state === "error" ? "Failed" : "Done";
  const hasDetail = Boolean(step.detail && step.detail.trim().length > 0);
  const isMultilineOrLong = Boolean(step.detail && (step.detail.includes("\n") || step.detail.length > 76));

  return (
    <li className={`step step-${step.kind} is-${step.state}`}>
      <div className="step-main">
        <span className={`step-badge badge-${step.kind}`}>
          <StepKindIcon kind={step.kind} size={13} />
          <span>{kindBadgeLabel(step.kind)}</span>
        </span>

        <span className="step-label">{step.label}</span>

        {hasDetail && !isMultilineOrLong && (
          <span className="step-detail-inline" title={step.detail}>
            {step.detail}
          </span>
        )}

        {hasDetail && isMultilineOrLong && (
          <button
            type="button"
            className="step-detail-btn"
            onClick={() => setDetailOpen((v) => !v)}
            aria-expanded={detailOpen}
            title={step.detail}
          >
            <span>{detailOpen ? "Hide output" : "Details"}</span>
            <ExpandIcon size={14} className={detailOpen ? "is-rotated" : undefined} />
          </button>
        )}

        <span className="step-state" title={stateLabel}>
          {step.state === "running" ? (
            <span className="spinner spinner-sm" aria-hidden="true" />
          ) : step.state === "error" ? (
            <ErrorIcon size={16} aria-hidden="true" />
          ) : (
            <CheckIcon size={16} aria-hidden="true" />
          )}
          <span className="sr-only">{stateLabel}</span>
        </span>
      </div>

      {hasDetail && isMultilineOrLong && detailOpen && (
        <pre className="step-detail-pre">{step.detail}</pre>
      )}
    </li>
  );
}

function StepsTrail({
  steps,
  streaming,
  interrupted,
  liveStatus,
}: {
  steps: Step[];
  streaming: boolean;
  interrupted: boolean;
  liveStatus: string | undefined;
}) {
  const hasActionSteps = steps.some((s) => s.kind !== "thought");
  const [toggled, setToggled] = useState<boolean | null>(null);
  const canExpand = steps.length > 0;
  // Keep MCP + Sandbox pills visible by default so live reviews clearly show tool execution.
  const expanded = canExpand && (toggled ?? (streaming || hasActionSteps));
  const label = streaming ? `${liveStatus || "Thinking"}…` : stepsSummary(steps);

  return (
    <div className={`steps${expanded ? " is-open" : ""}`}>
      <button
        type="button"
        className="steps-toggle"
        onClick={() => setToggled(!expanded)}
        disabled={!canExpand}
        aria-expanded={canExpand ? expanded : undefined}
      >
        {streaming ? (
          <span className="spinner" aria-hidden="true" />
        ) : (
          <CheckIcon size={16} className={`steps-done${interrupted ? " is-muted" : ""}`} aria-hidden="true" />
        )}
        <span className={streaming ? "shimmer" : undefined}>{label}</span>
        {canExpand && <ExpandIcon size={18} className="steps-chevron" aria-hidden="true" />}
      </button>
      {expanded && (
        <ol className="steps-list">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ol>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => undefined,
    );
  };

  return (
    <button
      type="button"
      className="icon-btn"
      onClick={copy}
      aria-label={copied ? "Copied" : "Copy review"}
      title="Copy review"
    >
      {copied ? <CheckIcon size={18} /> : <CopyIcon size={18} />}
    </button>
  );
}

interface AssistantMessageProps {
  message: Message;
  onRetry?: (() => void) | undefined;
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  onRetry,
}: AssistantMessageProps) {
  const streaming = message.status === "streaming";
  const steps = message.steps ?? [];
  const hasText = message.text.length > 0;
  const interrupted = message.status === "stopped" || message.status === "error" || message.status === "incomplete";
  const note =
    message.status === "stopped"
      ? "You stopped this review."
      : message.status === "incomplete"
        ? "This review may be incomplete."
        : null;

  return (
    <div className={`msg msg-assistant${streaming ? " is-streaming" : ""}`} aria-busy={streaming || undefined}>
      <div className="msg-avatar">
        <Sparkle size={24} className={streaming ? "spark-spin" : undefined} />
      </div>
      <div className="msg-body">
        {(streaming || steps.length > 0) && (
          <StepsTrail
            steps={steps}
            streaming={streaming}
            interrupted={interrupted}
            liveStatus={message.liveStatus}
          />
        )}
        {hasText && (
          <div>
            <MarkdownText text={streaming ? tidyStreamingMarkdown(message.text) : message.text} />
          </div>
        )}
        {!streaming && (
          <>
            {message.status === "error" && (
              <div className="msg-error" role="alert">
                <ErrorIcon size={18} />
                <span>{message.error || "Something went wrong. Please try again."}</span>
              </div>
            )}
            {note && <p className="msg-note">{note}</p>}
            {(hasText || onRetry) && (
              <div className="msg-actions">
                {hasText && <CopyButton text={message.text} />}
                {onRetry && (
                  <button type="button" className="chip-btn" onClick={onRetry}>
                    <RefreshIcon size={16} />
                    Try again
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});
