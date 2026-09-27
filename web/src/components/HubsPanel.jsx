import { Empty, Meter, Panel } from './primitives.jsx';

/**
 * Hub capacity.
 *
 * The bar shows commitment against capacity, because that ratio is the thing a
 * coordinator is actually deciding with: whether there is room left for the lot
 * in front of them. A hub at zero remaining is not excluded by the interface, it
 * is shown as full, so the reason a lot went unplaced is visible rather than
 * mysterious.
 */
export default function HubsPanel({ hubs, loading, error }) {
  if (error) {
    return (
      <Panel title="Hubs">
        <Empty>The hub list could not be loaded. {error}</Empty>
      </Panel>
    );
  }

  if (loading) {
    return (
      <Panel title="Hubs">
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-ink-850" />
          ))}
        </div>
      </Panel>
    );
  }

  if (hubs.length === 0) {
    return (
      <Panel title="Hubs">
        <Empty>No hubs registered. A hub is a shelter kitchen or community kitchen that can receive.</Empty>
      </Panel>
    );
  }

  return (
    <Panel
      title="Hubs"
      action={<span className="font-mono text-xs text-ink-400">{hubs.length} registered</span>}
    >
      <ul className="grid gap-3 sm:grid-cols-2">
        {hubs.map((hub) => {
          const full = hub.remainingMeals <= 0;
          const empty = hub.dailyCapacityMeals <= 0;
          return (
            <li key={hub.id} className="rounded-lg border border-ink-700 bg-ink-850/60 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink-50">{hub.name}</p>
                  <p className="truncate text-xs text-ink-400">{hub.organisation}</p>
                </div>
                <span
                  className={`tnum shrink-0 font-mono text-xs ${
                    full ? 'text-refuse-400' : empty ? 'text-ink-500' : 'text-safe-400'
                  }`}
                >
                  {empty ? 'not receiving' : full ? 'full' : `${hub.remainingMeals} left`}
                </span>
              </div>

              <div className="mt-3">
                <Meter
                  value={hub.committedMealsToday}
                  max={hub.dailyCapacityMeals}
                  tone={full ? 'refuse' : 'safe'}
                  label={`${hub.name}: ${hub.committedMealsToday} of ${hub.dailyCapacityMeals} meals committed`}
                />
                <p className="tnum mt-2 font-mono text-xs text-ink-400">
                  {hub.committedMealsToday} / {hub.dailyCapacityMeals} meals
                </p>
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-ink-700 pt-3 text-xs">
                <div>
                  <dt className="text-ink-500">Open</dt>
                  <dd className="tnum font-mono text-ink-300">{hub.opensAt?.slice(0, 5)}</dd>
                </div>
                <div>
                  <dt className="text-ink-500">Closes</dt>
                  <dd className="tnum font-mono text-ink-300">{hub.closesAt?.slice(0, 5)}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-ink-500">Accepts</dt>
                  <dd className="mt-0.5 flex flex-wrap gap-1">
                    {(hub.accepts ?? []).map((c) => (
                      <span
                        key={c}
                        className="rounded border border-ink-600 px-1.5 py-0.5 font-mono text-[10px] text-ink-300"
                      >
                        {c}
                      </span>
                    ))}
                  </dd>
                </div>
              </dl>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
