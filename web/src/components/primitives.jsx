/**
 * Shared primitives.
 *
 * Grouped in one file because each is a handful of lines and splitting them
 * would be more files than code. Nothing here fetches, so they stay trivially
 * renderable and testable on their own.
 */

/** A titled surface. The rule is one level of inset, no nested cards. */
export function Panel({ title, note, action, children, className = '', id }) {
  return (
    <section
      id={id}
      className={`rounded-xl border border-ink-700 bg-ink-900/80 backdrop-blur-[2px] ${className}`}
    >
      {(title || action) && (
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-ink-700 px-5 py-4">
          <h2 className="text-sm font-semibold tracking-wide text-ink-50 uppercase">{title}</h2>
          {action}
        </header>
      )}
      {note && <p className="px-5 pt-4 text-sm leading-relaxed text-ink-300">{note}</p>}
      <div className={note ? 'px-5 pb-5' : 'p-5'}>{children}</div>
    </section>
  );
}

const SIZES = {
  xl: 'text-5xl sm:text-6xl',
  lg: 'text-4xl sm:text-5xl',
  md: 'text-3xl sm:text-4xl',
};

/**
 * A figure with its unit and its basis.
 *
 * The basis line is not decoration. A meals number with no stated denominator is
 * how a figure gets quoted out of context, so every stat here can say what it
 * was computed from.
 */
export function Stat({ value, unit, label, basis, size = 'lg', tone = 'ink-50' }) {
  return (
    <div className="min-w-0">
      <p className="flex items-baseline gap-1.5">
        <span className={`tnum font-display font-bold ${SIZES[size]} ${toneTone(tone)}`}>{value}</span>
        {unit && <span className="text-sm font-medium text-ink-400">{unit}</span>}
      </p>
      <p className="mt-2 text-sm font-medium text-ink-200">{label}</p>
      {basis && <p className="mt-1 text-xs leading-relaxed text-ink-400">{basis}</p>}
    </div>
  );
}

function toneTone(tone) {
  return (
    {
      'ink-50': 'text-ink-50',
      safe: 'text-safe-500',
      pending: 'text-pending-500',
      refuse: 'text-refuse-500',
      engine: 'text-engine-500',
    }[tone] ?? 'text-ink-50'
  );
}

const TONES = {
  safe: 'border-safe-500/35 bg-safe-900/40 text-safe-400',
  pending: 'border-pending-500/35 bg-pending-900/40 text-pending-400',
  refuse: 'border-refuse-500/35 bg-refuse-900/40 text-refuse-400',
  engine: 'border-engine-500/35 bg-engine-900/40 text-engine-400',
  idle: 'border-ink-600 bg-ink-850 text-ink-300',
};

/** A status, readable without relying on the colour alone. */
export function StatusPill({ tone = 'idle', children }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * A capacity bar.
 *
 * Over 100% renders in the refuse colour, because the only way to get here is a
 * database constraint having been bypassed and that should be visible rather
 * than clipped.
 */
export function Meter({ value, max, tone = 'safe', label }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const over = max > 0 && value > max;
  const colour = over ? 'bg-refuse-500' : tone === 'pending' ? 'bg-pending-500' : 'bg-safe-500';

  return (
    <div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-ink-800"
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label}
      >
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** A labelled bar in a list, for the impact breakdowns. */
export function BarRow({ label, value, suffix = '', max, tone = 'safe' }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5">
      <span className="truncate text-sm text-ink-200">{label}</span>
      <span className="tnum text-right text-sm font-medium text-ink-100">
        {value.toLocaleString()}
        {suffix && <span className="ml-1 text-ink-400">{suffix}</span>}
      </span>
      <span className="col-span-2 h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
        <span
          className={`block h-full rounded-full ${
            tone === 'engine' ? 'bg-engine-500' : tone === 'pending' ? 'bg-pending-500' : 'bg-safe-500'
          }`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </span>
    </li>
  );
}

/**
 * What is shown when there is genuinely nothing.
 *
 * Distinct from the error note: an empty dashboard with a real API behind it is
 * information, and dressing it as a failure would train people to ignore it.
 */
export function Empty({ children }) {
  return (
    <p className="rounded-lg border border-dashed border-ink-700 px-4 py-8 text-center text-sm text-ink-400">
      {children}
    </p>
  );
}

/** How a refusal reason reads. One place, so the wording cannot drift. */
export const REASON_TEXT = {
  no_expiry_recorded: 'No safe-until time was recorded',
  past_safe_use: 'Past its safe-until time',
  hot_holding_too_long: 'Held hot for over two hours',
  cold_chain_broken: 'Cold chain not maintained',
  window_not_recorded: 'No pickup window recorded',
  window_closed: 'Pickup window already closed',
  window_closes_too_soon: 'Not enough time left to collect',
  window_in_past: 'Pickup window is in the past',
  unknown: 'Refused for an unrecorded reason',
};

export const statusTone = (status) =>
  ({
    listed: 'pending',
    assigned: 'engine',
    collected: 'safe',
    refused: 'refuse',
    expired: 'refuse',
  })[status] ?? 'idle';

export const statusLabel = (status) =>
  ({
    listed: 'Awaiting a hub',
    assigned: 'Assigned',
    collected: 'Collected',
    refused: 'Refused',
    expired: 'Expired',
  })[status] ?? status;
