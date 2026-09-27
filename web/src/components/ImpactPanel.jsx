import { BarRow, Empty, Panel, Stat } from './primitives.jsx';

/**
 * The impact report.
 *
 * The four figures are the claim the project makes, so each one carries the
 * basis it was computed from directly beneath it. A meals number with no stated
 * denominator is a number that gets quoted without its caveats, and the
 * denominator here is the part that matters: completed handovers only.
 */
export default function ImpactPanel({ data, loading, error }) {
  if (error) {
    return (
      <Panel title="Impact">
        <Empty>The impact report could not be loaded. {error}</Empty>
      </Panel>
    );
  }

  if (loading || !data) {
    return (
      <Panel title="Impact">
        <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <div className="h-10 w-24 animate-pulse rounded bg-ink-800" />
              <div className="h-4 w-32 animate-pulse rounded bg-ink-800" />
            </div>
          ))}
        </div>
      </Panel>
    );
  }

  const { totals, byHub, byCategory, basis, excludedNotCollected } = data;
  const nothing = totals.collections === 0;

  if (nothing) {
    return (
      <Panel title="Impact">
        <Empty>No completed collections yet, so there is nothing to report.</Empty>
        <p className="mt-3 text-xs leading-relaxed text-ink-400">{basis}</p>
      </Panel>
    );
  }

  const maxHub = Math.max(...byHub.map((h) => h.meals), 1);
  const maxCat = Math.max(...byCategory.map((c) => c.meals), 1);

  return (
    <Panel
      title="Impact"
      action={
        <span className="font-mono text-xs text-ink-400">from {totals.collections} completed handover{totals.collections === 1 ? '' : 's'}</span>
      }
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-8 lg:grid-cols-4">
        <Stat
          value={totals.meals.toLocaleString()}
          label="Meals delivered"
          size="xl"
          tone="safe"
          basis="250 g a serving. Counted once per handover, and never from a listing."
        />
        <Stat
          value={totals.kg.toLocaleString()}
          unit="kg"
          label="Food rescued"
          size="xl"
          basis="What the hub says it received, not what was listed."
        />
        <Stat
          value={Math.round(totals.co2eKg).toLocaleString()}
          unit="kg CO₂e"
          label="Emissions avoided"
          size="xl"
          basis="Landfill and refrigeration displaced. A standard factor, not a measurement."
        />
        <Stat
          value={excludedNotCollected}
          label="Left out on purpose"
          size="xl"
          tone="pending"
          basis="Cancelled, missed or never-collected handovers. Counted in no total above."
        />
      </div>

      <div className="mt-8 grid gap-8 border-t border-ink-700 pt-7 lg:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold tracking-widest text-ink-300 uppercase">
            Meals by hub
          </h3>
          <ul className="mt-4 space-y-3.5">
            {byHub.map((h) => (
              <BarRow
                key={h.hubName}
                label={h.hubName}
                value={h.meals}
                suffix="meals"
                max={maxHub}
                tone="engine"
              />
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-xs font-semibold tracking-widest text-ink-300 uppercase">
            Meals by category
          </h3>
          <ul className="mt-4 space-y-3.5">
            {byCategory.map((c) => (
              <BarRow
                key={c.category}
                label={c.category}
                value={c.meals}
                suffix="meals"
                max={maxCat}
                tone="safe"
              />
            ))}
          </ul>
        </div>
      </div>

      <p className="mt-7 border-t border-ink-700 pt-4 text-xs leading-relaxed text-ink-400">
        {basis}
      </p>
    </Panel>
  );
}
