/* ─────────────────────────────────────────────────────────────────────────
   Marathon — brand mark + wordmark.

   Classic Mark: black rounded square with three chevrons (» »); the third
   uses `var(--accent)` so it follows the user's accent palette.

   Beta Mark: black rounded square with two stacked arrow shapes — white
   below, accent above. Only shown when the global beta-design flag is on
   (see [[hooks/useBetaDesign]]). Both marks share the same accent var so
   retheming propagates without a re-render.
   ───────────────────────────────────────────────────────────────────────── */
import { useBetaDesign } from '@/hooks/useBetaDesign';

export function Mark({ size = 28 }) {
  const { beta } = useBetaDesign();
  if (beta) return <BetaMark size={size} />;
  return <ClassicMark size={size} />;
}

function ClassicMark({ size = 28 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 503 503"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block' }}
    >
      <rect width="503" height="503" rx="111" fill="black" />
      <path d="M128 147L218 252L128 357" stroke="#F3F1EC" strokeWidth="39" strokeLinecap="square" />
      <path d="M225 147L317 252L225 357" stroke="#F3F1EC" strokeWidth="39" strokeLinecap="square" />
      <path d="M324 147L414 252L324 357" stroke="var(--accent)" strokeWidth="39" strokeLinecap="square" />
    </svg>
  );
}

function BetaMark({ size = 28 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 46 47"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block' }}
    >
      <rect width="46" height="47" rx="13" fill="black" />
      <path
        d="M23.8428 13C24.9036 13 25.9208 13.4217 26.6709 14.1719L33.1709 20.6719C34.733 22.234 34.733 24.766 33.1709 26.3281L26.6709 32.8281C25.9208 33.5783 24.9036 34 23.8428 34H16.707C16.5749 34 16.4458 33.993 16.3203 33.9814C16.2017 33.993 16.0821 34 15.9619 34C12.6547 34 10.9986 30.0017 13.3369 27.6631L14.6709 26.3281C16.233 24.766 16.233 22.234 14.6709 20.6719L13.3369 19.3369C10.9986 16.9983 12.6547 13 15.9619 13C16.0821 13 16.2017 13.0061 16.3203 13.0176C16.4458 13.006 16.575 13 16.707 13H23.8428Z"
        fill="white"
      />
      <path
        d="M25.921 34H25.3249C21.2951 34 20.1799 28.4645 23.8953 26.904C26.9117 25.6371 26.9117 21.3629 23.8953 20.096C20.1799 18.5355 21.2951 13 25.3249 13H25.921C26.932 13 27.9016 13.4016 28.6165 14.1165L35.1716 20.6716C36.7337 22.2337 36.7337 24.7663 35.1716 26.3284L28.6165 32.8835C27.9016 33.5984 26.932 34 25.921 34Z"
        fill="var(--accent)"
      />
    </svg>
  );
}

/* Wordmark: icon + "MARATHON" in display font, optional dot/tagline. */
export function Wordmark({ iconSize = 28, textSize = 16, color = 'var(--ink)', accentDot = false, tagline }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 10,
      lineHeight: 1,
    }}>
      <Mark size={iconSize} />
      <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.05 }}>
        <span style={{
          fontFamily: 'var(--font-display)',
          fontSize: textSize,
          fontWeight: 800,
          letterSpacing: '0.04em',
          color,
          textTransform: 'uppercase',
        }}>
          Marathon{accentDot && <span style={{ color: 'var(--accent)' }}>.</span>}
        </span>
        {tagline && (
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: Math.max(8, textSize * 0.55),
            letterSpacing: '0.22em',
            color: 'var(--ink-3)',
            marginTop: 4,
            textTransform: 'uppercase',
          }}>
            {tagline}
          </span>
        )}
      </span>
    </span>
  );
}
