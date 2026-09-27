import { useCallback, useEffect, useState } from 'react';

import { api, apiBase } from './api.js';
import AboutPanel from './components/AboutPanel.jsx';
import HubsPanel from './components/HubsPanel.jsx';
import ImpactPanel from './components/ImpactPanel.jsx';
import RoutingDiagram from './components/RoutingDiagram.jsx';
import SurplusPanel from './components/SurplusPanel.jsx';
import { Panel, StatusPill } from './components/primitives.jsx';

const TABS = [
  { key: 'impact', label: 'Impact' },
  { key: 'surplus', label: 'Surplus' },
  { key: 'hubs', label: 'Hubs' },
  { key: 'how', label: 'How it works' },
  { key: 'about', label: 'About' },
];

export default function App() {
  const [tab, setTab] = useState('impact');
  const [impact, setImpact] = useState(null);
  const [lots, setLots] = useState([]);
  const [hubs, setHubs] = useState([]);
  const [about, setAbout] = useState(null);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [i, s, h, a, hp] = await Promise.all([
        api.impact(),
        api.surplus(),
        api.hubs(),
        api.about(),
        api.health().catch(() => null),
      ]);
      setImpact(i);
      setLots(s.surplus ?? []);
      setHubs(h.hubs ?? []);
      setAbout(a);
      setHealth(hp);
    } catch (err) {
      // Deliberately one message and no partial figures. Showing the impact
      // numbers that did load while hiding the panel that failed would imply the
      // whole picture was there when it was not.
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const online = health?.status === 'ok' && health?.database === 'ok';

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-safe-500 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-ink-950"
      >
        Skip to content
      </a>

      <header className="border-b border-ink-800">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-4 sm:px-8">
          <div className="flex items-center gap-2.5">
            <Mark />
            <span className="font-display text-base font-bold tracking-tight text-ink-50">
              FoodForward
            </span>
          </div>

          <div className="flex items-center gap-3">
            <StatusPill tone={online ? 'safe' : health ? 'pending' : 'idle'}>
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${
                  online ? 'bg-safe-500' : health ? 'bg-pending-500' : 'bg-ink-500'
                }`}
              />
              {online ? 'API connected' : health ? 'API degraded' : error ? 'API unreachable' : 'Connecting'}
            </StatusPill>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-6xl px-5 pb-24 sm:px-8">
        <section className="pt-12 pb-10 sm:pt-16">
          <p className="font-mono text-xs tracking-widest text-safe-400 uppercase">
            Surplus food routing
          </p>
          <h1 className="mt-4 max-w-3xl text-4xl leading-[1.08] font-bold text-ink-50 sm:text-5xl lg:text-6xl">
            Food that is safe to send, sent to someone who can use it.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-ink-300 sm:text-lg">
            Restaurants and events list surplus. The router finds a nearby shelter hub that has room,
            is open, and accepts that category. Surplus with no safe-until time, or one already past,
            is refused before any hub is considered.
          </p>
        </section>

        {error && (
          <div className="mb-8 rounded-lg border border-refuse-500/35 bg-refuse-900/25 p-4">
            <p className="text-sm font-medium text-refuse-400">Live data unavailable</p>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-200">{error}</p>
            <p className="mt-2 text-xs leading-relaxed text-ink-400">
              Nothing on this page is fabricated when the API is down. Start the backend and reload, or
              point <code className="font-mono text-ink-300">VITE_API_URL</code> at a running instance.
            </p>
            <p className="mt-2 font-mono text-xs text-ink-500">API base: {apiBase}</p>
          </div>
        )}

        <nav aria-label="Sections" className="mb-7 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
          <ul className="flex gap-1 border-b border-ink-800">
            {TABS.map((t) => (
              <li key={t.key} className="shrink-0">
                <button
                  type="button"
                  onClick={() => setTab(t.key)}
                  aria-current={tab === t.key ? 'page' : undefined}
                  className={`-mb-px border-b-2 px-3.5 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
                    tab === t.key
                      ? 'border-safe-500 text-ink-50'
                      : 'border-transparent text-ink-400 hover:text-ink-100'
                  }`}
                >
                  {t.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="space-y-4">
          {tab === 'impact' && <ImpactPanel data={impact} loading={loading} error={error} />}

          {tab === 'surplus' && (
            <SurplusPanel lots={lots} loading={loading} error={error} onChanged={load} />
          )}

          {tab === 'hubs' && <HubsPanel hubs={hubs} loading={loading} error={error} />}

          {tab === 'how' && (
            <Panel title="How a listing becomes a meal">
              <RoutingDiagram />
            </Panel>
          )}

          {tab === 'about' && <AboutPanel about={about} />}
        </div>
      </main>

      <footer className="border-t border-ink-800">
        <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8">
          <p className="text-xs leading-relaxed text-ink-500">
            A demonstration of surplus food routing. Not a food safety authority, and not a service
            anyone should rely on to move real food. Published as JETIR2404570 in the{' '}
            <em>International Journal of Emerging Technologies and Innovative Research</em>, April 2024.
          </p>
        </div>
      </footer>
    </div>
  );
}

function Mark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6 text-safe-500"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v13" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  );
}
