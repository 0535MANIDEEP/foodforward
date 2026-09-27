/**
 * The routing pipeline.
 *
 * Drawn in HTML rather than as an SVG, which is a deliberate reversal of the
 * usual choice. A diagram is mostly text, and SVG text scales with the graphic:
 * at 320px wide an 880 unit viewBox turns a 14 unit label into roughly 5px of
 * unreadable grey. Boxes with real text reflow, stay selectable, stay
 * translatable and get read by a screen reader without a parallel description
 * nobody maintains.
 *
 * The layout runs vertically on a phone and horizontally from `md` up. The
 * connectors are the same element either way, rotated 90 degrees, so there is
 * one diagram rather than two that can drift apart.
 */

const STAGES = [
  {
    n: '01',
    title: 'Supplier listing',
    body: 'Weight, category, pickup window and the safe-until time, or the absence of one.',
    tone: 'idle',
  },
  {
    n: '02',
    title: 'Safety check',
    body: 'Unknown expiry or an expired lot is refused here. It never reaches the router.',
    tone: 'refuse',
  },
  {
    n: '03',
    title: 'Routing engine',
    body: 'Ranks hubs by distance, remaining capacity, overlap and what they accept.',
    tone: 'engine',
  },
  {
    n: '04',
    title: 'Hub receives',
    body: 'Capacity is held from assignment until the food is actually handed over.',
    tone: 'safe',
  },
];

const TONE_RING = {
  idle: 'border-ink-600 bg-ink-850',
  refuse: 'border-refuse-500/45 bg-refuse-900/30',
  engine: 'border-engine-500/45 bg-engine-900/30',
  safe: 'border-safe-500/45 bg-safe-900/30',
};

const TONE_NUM = {
  idle: 'text-ink-400',
  refuse: 'text-refuse-400',
  engine: 'text-engine-400',
  safe: 'text-safe-400',
};

function Stage({ n, title, body, tone }) {
  return (
    <li className="min-w-0 flex-1">
      <div className={`h-full rounded-lg border p-4 ${TONE_RING[tone]}`}>
        <p className={`tnum font-mono text-xs ${TONE_NUM[tone]}`}>{n}</p>
        <p className="mt-1.5 font-display text-sm leading-snug font-semibold text-ink-50 sm:text-base">
          {title}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-ink-300 sm:text-sm">{body}</p>
      </div>
    </li>
  );
}

function Connector() {
  return (
    <li aria-hidden="true" className="flex shrink-0 items-center justify-center py-1 md:py-0 md:px-1">
      <svg
        viewBox="0 0 24 24"
        className="h-6 w-6 rotate-90 text-ink-600 md:rotate-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 12h15" />
        <path d="m13 6 6 6-6 6" />
      </svg>
    </li>
  );
}

const OUTCOMES = [
  {
    kind: 'Refused',
    tone: 'refuse',
    detail: 'No safe-until time recorded, or already past it.',
    where: 'Step 02, before any hub is considered',
  },
  {
    kind: 'Refused',
    tone: 'refuse',
    detail: 'Hot held over two hours, or the cold chain was not maintained.',
    where: 'Step 02, before any hub is considered',
  },
  {
    kind: 'Not placed',
    tone: 'pending',
    detail: 'No active hub has room, is open, or accepts that category.',
    where: 'Step 03, reported rather than dropped',
  },
  {
    kind: 'Not counted',
    tone: 'idle',
    detail: 'A handover that was cancelled or missed feeds nobody, so it adds nothing to the impact total.',
    where: 'Impact reporting',
  },
];

const OUTCOME_RING = {
  refuse: 'border-refuse-500/30 bg-refuse-900/20',
  pending: 'border-pending-500/30 bg-pending-900/20',
  idle: 'border-ink-600 bg-ink-850/60',
};

const OUTCOME_TEXT = {
  refuse: 'text-refuse-400',
  pending: 'text-pending-400',
  idle: 'text-ink-300',
};

export default function RoutingDiagram() {
  // Flat list with the connectors interleaved, rather than wrapping each pair in
  // a fragment. Same result, one element fewer in the tree.
  const items = STAGES.flatMap((stage, i) =>
    i === 0 ? [<Stage key={stage.n} {...stage} />] : [<Connector key={`c${i}`} />, <Stage key={stage.n} {...stage} />],
  );

  return (
    <div>
      <ol className="flex flex-col gap-0 md:flex-row md:items-stretch">{items}</ol>

      <div className="mt-6 rounded-lg border border-ink-700 bg-ink-950/60 p-4 sm:p-5">
        <h3 className="text-xs font-semibold tracking-widest text-ink-300 uppercase">
          Where a lot stops, and why
        </h3>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {OUTCOMES.map((o, i) => (
            <li key={i} className={`rounded-lg border p-3.5 ${OUTCOME_RING[o.tone]}`}>
              <p className={`text-xs font-semibold tracking-wide uppercase ${OUTCOME_TEXT[o.tone]}`}>
                {o.kind}
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-200">{o.detail}</p>
              <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-ink-500">{o.where}</p>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs leading-relaxed text-ink-400">
          Every one of these is a refusal that returns to the supplier with a reason. None of them is a
          warning in the interface, because a warning is something a busy person clicks past.
        </p>
      </div>
    </div>
  );
}
