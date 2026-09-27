/**
 * What this is, and what it is not.
 *
 * This panel exists because the most misleading thing a demo of a food rescue
 * project can do is let a reader assume it is a working public service. It is
 * not. It has no accounts, no moderation, no background jobs, and no food safety
 * authority behind it. Saying so in the interface is worth more than a page of
 * feature bullets.
 */
export default function AboutPanel({ about }) {
  const limits = about?.whatItIsNot ?? [
    'Not a food safety authority.',
    'Not a substitute for a commercial kitchen or a charity.',
    'Not a certification that any food is safe to eat.',
  ];
  const paper = about?.paper;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-xl border border-ink-700 bg-ink-900/80 p-5">
        <h2 className="text-sm font-semibold tracking-wide text-ink-50 uppercase">What this is not</h2>
        <ul className="mt-4 space-y-2.5">
          {limits.map((l) => (
            <li key={l} className="flex gap-2.5 text-sm leading-relaxed text-ink-200">
              <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-refuse-500" />
              {l}
            </li>
          ))}
        </ul>

        <h3 className="mt-6 text-xs font-semibold tracking-widest text-ink-300 uppercase">
          Authentication
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-ink-300">
          {about?.authentication ??
            'None. Open endpoints, intended for a demonstration or a small pilot. Do not put real data in it.'}
        </p>

        <h3 className="mt-6 text-xs font-semibold tracking-widest text-ink-300 uppercase">
          Safety rule
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-ink-300">
          {about?.safetyRule}
        </p>
      </div>

      <div className="rounded-xl border border-ink-700 bg-ink-900/80 p-5">
        <h2 className="text-sm font-semibold tracking-wide text-ink-50 uppercase">Published paper</h2>
        {paper ? (
          <div className="mt-4">
            <p className="font-display text-lg leading-snug font-semibold text-ink-50">
              {paper.title}
            </p>
            <p className="mt-2 text-sm text-ink-300">{paper.authors}</p>
            <dl className="mt-4 space-y-1.5 border-t border-ink-700 pt-4 text-sm">
              {[
                ['Journal', paper.journal],
                ['ISSN', paper.issn],
                ['Volume', `${paper.volume}, Issue ${paper.issue}`],
                ['Pages', paper.pages],
                ['Published', paper.month],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-3">
                  <dt className="w-20 shrink-0 text-ink-500">{k}</dt>
                  <dd className="text-ink-200">{v}</dd>
                </div>
              ))}
            </dl>
            <a
              href={paper.url}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-5 inline-flex items-center gap-2 rounded-md border border-ink-600 bg-ink-850 px-4 py-2 text-sm font-medium text-ink-100 transition-colors hover:border-safe-500/60 hover:text-safe-400"
            >
              Read the paper
              <span aria-hidden="true">↗</span>
            </a>
            <p className="mt-3 text-xs leading-relaxed text-ink-400">
              The 2024 paper describes a prototype in HTML, CSS, JavaScript, Node.js and MySQL. This
              interface is the expanded implementation, rebuilt in React and Tailwind. The MySQL
              schema, the routing rules and the safety refusals follow the paper.
            </p>
          </div>
        ) : (
          <p className="mt-4 text-sm text-ink-400">The citation could not be loaded from the API.</p>
        )}
      </div>
    </div>
  );
}
