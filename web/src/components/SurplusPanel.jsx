import { useState } from 'react';

import { api } from '../api.js';
import { Empty, Panel, REASON_TEXT, StatusPill, statusLabel, statusTone } from './primitives.jsx';

/**
 * The surplus board.
 *
 * A refused lot stays on the board, in red, with its reason. It is not hidden
 * and not deleted, because a supplier whose food was refused needs to be able to
 * see why and fix it, and a coordinator needs to see that it happened at all.
 */
export default function SurplusPanel({ lots, loading, error, onChanged, busyId }) {
  const [pendingId, setPendingId] = useState(null);

  const grouped = [
    {
      key: 'listed',
      title: 'Awaiting a hub',
      // Split out, because a lot that the safety rules will refuse is not
      // awaiting anything. Showing it under the same heading as a lot that could
      // be placed tomorrow morning misrepresents it as merely pending.
      lots: lots.filter((l) => l.status === 'listed' && l.safety?.safe !== false),
    },
    {
      key: 'unsafe',
      title: 'Will be refused',
      lots: lots.filter((l) => l.status === 'listed' && l.safety?.safe === false),
    },
    { key: 'assigned', title: 'Assigned', lots: lots.filter((l) => l.status === 'assigned') },
    { key: 'collected', title: 'Collected', lots: lots.filter((l) => l.status === 'collected') },
    {
      key: 'refused',
      title: 'Refused',
      lots: lots.filter((l) => l.status === 'refused' || l.status === 'expired'),
    },
  ];

  async function assign(id) {
    setPendingId(id);
    try {
      await api.assign(id);
      await onChanged();
    } catch {
      // The refusal is already visible on the board as a status change, which is
      // the record the person needs. Swallowing it here avoids a second, vaguer
      // error message on top of the specific one.
    } finally {
      setPendingId(null);
    }
  }

  if (error) {
    return (
      <Panel title="Surplus">
        <Empty>The surplus board could not be loaded. {error}</Empty>
      </Panel>
    );
  }

  if (loading) {
    return (
      <Panel title="Surplus">
        <div className="space-y-2.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-ink-850" />
          ))}
        </div>
      </Panel>
    );
  }

  if (lots.length === 0) {
    return (
      <Panel title="Surplus">
        <Empty>No surplus listed yet. Post a listing through POST /api/surplus to see it here.</Empty>
      </Panel>
    );
  }

  return (
    <Panel
      title="Surplus"
      action={<span className="font-mono text-xs text-ink-400">{lots.length} listings</span>}
    >
      <div className="space-y-7">
        {grouped
          .filter((g) => g.lots.length > 0)
          .map((group) => (
            <section key={group.key}>
              <h3 className="flex items-baseline gap-2 text-xs font-semibold tracking-widest text-ink-300 uppercase">
                {group.title}
                <span className="tnum font-mono text-ink-500">{group.lots.length}</span>
              </h3>

              <ul className="mt-3 space-y-2.5">
                {group.lots.map((lot) => {
                  const unsafe = lot.safety?.safe === false;
                  const firstReason = lot.safety?.reasons?.[0]?.reason ?? null;
                  // A listed lot that the rules will refuse is toned as refused,
                  // not as pending, and gets no action button. Offering a button
                  // that can only ever return a refusal is a worse interface than
                  // saying so up front.
                  const tone = unsafe ? 'refuse' : statusTone(lot.status);
                  const working = busyId === lot.id || pendingId === lot.id;
                  return (
                    <li
                      key={lot.id}
                      className="grid gap-x-4 gap-y-2.5 rounded-lg border border-ink-700 bg-ink-850/60 p-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-4"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                          <StatusPill tone={tone}>
                            {unsafe ? 'Unsafe to route' : statusLabel(lot.status)}
                          </StatusPill>
                          <span className="truncate text-sm font-medium text-ink-50">{lot.title}</span>
                          <span className="font-mono text-xs text-ink-500">{lot.category}</span>
                        </div>

                        <p className="tnum mt-1.5 text-sm text-ink-300">
                          {lot.quantityKg} kg
                          {lot.safeUntil ? (
                            <>
                              {' · safe until '}
                              <time dateTime={lot.safeUntil}>{formatWhen(lot.safeUntil)}</time>
                            </>
                          ) : (
                            <span className="text-refuse-400"> · no safe-until time recorded</span>
                          )}
                        </p>

                        {firstReason && !lot.refusalReason && (
                          <p className="mt-1.5 text-xs leading-relaxed text-refuse-400">
                            {REASON_TEXT[firstReason] ?? REASON_TEXT.unknown}
                            <span className="ml-1.5 font-mono text-ink-500">({firstReason})</span>
                          </p>
                        )}

                        {lot.refusalReason && (
                          <p className="mt-1.5 text-xs leading-relaxed text-refuse-400">
                            {REASON_TEXT[lot.refusalReason] ?? REASON_TEXT.unknown}
                            <span className="ml-1.5 font-mono text-ink-500">
                              ({lot.refusalReason})
                            </span>
                          </p>
                        )}
                      </div>

                      {lot.status === 'listed' && !unsafe && (
                        <button
                          type="button"
                          onClick={() => assign(lot.id)}
                          disabled={working}
                          className="w-full rounded-md border border-engine-500/40 bg-engine-900/40 px-4 py-2 text-sm font-medium text-engine-400 transition-colors hover:border-engine-500/70 hover:text-engine-400 disabled:cursor-wait disabled:opacity-50 sm:w-auto"
                        >
                          {working ? 'Routing…' : 'Find a hub'}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
      </div>
    </Panel>
  );
}

/**
 * A short label, past or future.
 *
 * The past branch exists because collapsing every expired time to "now" is a
 * lie of convenience: a lot that expired two hours ago and one that expired a
 * second ago both read "safe until now", which reads as if it were still good.
 * "overdue" is the honest word.
 */
function formatWhen(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;

  const mins = Math.round((then - Date.now()) / 60_000);

  if (mins < 0) {
    const ago = Math.abs(mins);
    if (ago < 60) return 'now (overdue)';
    if (ago < 60 * 48) return `overdue by ${Math.round(ago / 60)} h`;
    return `overdue by ${Math.round(ago / 1440)} days`;
  }

  if (mins === 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}
