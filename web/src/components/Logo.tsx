import { useId } from "react";

const SPARK_PATH =
  "M12 2c.35 3.6 1.4 6.1 3.15 7.85S19.4 11.65 22 12c-2.6.35-5.1 1.4-6.85 3.15S12.35 18.4 12 22c-.35-3.6-1.4-6.1-3.15-7.85S4.6 12.35 2 12c2.6-.35 5.1-1.4 6.85-3.15S11.65 5.6 12 2z";

/** Four-point gradient Gemini sparkle used for the brand mark and assistant avatar. */
export function Sparkle({ size = 24, className }: { size?: number; className?: string }) {
  const gradientId = `spark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gradientId} x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4285f4" />
          <stop offset="0.55" stopColor="#9b72cb" />
          <stop offset="1" stopColor="#d96570" />
        </linearGradient>
      </defs>
      <path fill={`url(#${gradientId})`} d={SPARK_PATH} />
    </svg>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <span className="logo">
      <Sparkle size={size + 2} />
      <span className="logo-word">RepoReview</span>
    </span>
  );
}
