import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Does Tailwind actually generate the classes this interface asks for?
 *
 * Tailwind finds classes by scanning source text for literal strings. It cannot
 * resolve a variable, so this code
 *
 *     const TONES = { safe: 'border-safe-500/35 bg-safe-900/40 text-safe-400' };
 *     <span className={TONES[tone]} />
 *
 * only works because the literal string happens to be in the source file. Change
 * the key, build a class name by concatenation, or move the map to a file the
 * scanner skips, and the rule is never emitted. The component still renders, the
 * build still succeeds, the unit tests still pass, and the element quietly
 * loses its colour.
 *
 * That is not hypothetical: it is exactly what removed the navigation from the
 * portfolio's header, where `hidden ${DESKTOP_FROM}:flex` produced a class name
 * no scanner could see. The deployed site was a working page with no menu on it.
 *
 * So this asserts against the generated stylesheet rather than against intent.
 */

// This file sits in web/, beside index.html and vite.config.js, so the web root
// is its own directory rather than its parent.
const WEB_ROOT = import.meta.dirname;
const SRC = path.join(WEB_ROOT, 'src');
const VITE_BIN = path.join(WEB_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

/**
 * A token has to look like a Tailwind class, not merely start with a letter that
 * some utility also starts with.
 *
 * The first version of this matched single letter prefixes, so `pending`,
 * `main`, `hubs` and `with` all looked like the `p`, `m`, `h` and `w`
 * utilities. Requiring either a hyphen or membership of a short list of
 * hyphenless utilities removes every one of those without letting real class
 * names through.
 */
const STANDALONE = new Set([
  'flex', 'grid', 'hidden', 'block', 'inline', 'contents', 'table',
  'absolute', 'relative', 'fixed', 'sticky', 'static',
  'visible', 'invisible', 'isolate', 'container', 'truncate',
  'underline', 'overline', 'uppercase', 'lowercase', 'capitalize', 'italic',
  'antialiased', 'tnum',
]);

/** Valid Tailwind class characters only: no quotes, punctuation or operators. */
const CLASS_SHAPE = /^[a-z0-9_:/.[\]%()-]+$/;

/** Variant prefixes, stripped before the utility root is judged. */
const VARIANTS = /^(?:(?:sm|md|lg|xl|2xl|hover|focus|focus-visible|active|disabled|group-hover|dark|first|last|odd|even|max|min|not|peer-checked):)+/;

/**
 * The cleaned class name, or null if this token is not a class.
 *
 * Returns the cleaned value rather than a boolean because the caller has to look
 * the same cleaned string up in the stylesheet. Returning a boolean here and
 * passing the raw token onwards is how a test ends up searching the CSS for
 * "'bg-safe-500'" and reporting fifty classes that are all present.
 */
function asClass(token) {
  const clean = token.replace(/^['"`]+|['"`;,.]+$/g, '');
  if (!clean || clean.startsWith('--') || clean.includes('${')) return null;
  if (!CLASS_SHAPE.test(clean)) return null;
  if (STANDALONE.has(clean)) return clean;
  // A hyphenated token must have a real utility root before its first hyphen,
  // otherwise ordinary hyphenated English passes as a class.
  const body = clean.replace(VARIANTS, '');
  const root = body.split(/[-:/[]/)[0];
  if (!/^[a-z][a-z0-9]*$/.test(root) || !body.includes('-')) return null;
  return UTILITY_ROOTS.has(root) ? clean : null;
}

const UTILITY_ROOTS = new Set([
  'text', 'bg', 'border', 'ring', 'shadow', 'outline', 'divide', 'from', 'via', 'to',
  'fill', 'stroke', 'font', 'tracking', 'leading', 'rounded', 'blur', 'backdrop',
  'opacity', 'gap', 'space', 'grid', 'cols', 'rows', 'col', 'row', 'order', 'basis',
  'grow', 'shrink', 'items', 'justify', 'self', 'content', 'place', 'overflow',
  'object', 'aspect', 'transition', 'duration', 'ease', 'delay', 'animate',
  'translate', 'rotate', 'scale', 'inset', 'top', 'right', 'bottom', 'left',
  'list', 'whitespace', 'break', 'decoration', 'underline', 'uppercase', 'lowercase',
  'capitalize', 'antialiased', 'isolate', 'filter', 'touch', 'scroll', 'snap',
  'p', 'px', 'py', 'pt', 'pb', 'pl', 'pr', 'm', 'mx', 'my', 'mt', 'mb', 'ml', 'mr',
  'w', 'h', 'size', 'min', 'max', 'z', 't', 'b', 'l', 'r', 'x', 'y', 'f', 's',
  'pointer', 'select', 'align', 'float', 'clear', 'sr', 'not', 'backface',
  'perspective', 'table', 'columns', 'caret', 'accent', 'will', 'content',
]);

/**
 * Every class token the source mentions literally, and whether the stylesheet
 * actually contains a rule for it.
 *
 * Escaping matters more than it looks. Tailwind emits `.md\:flex-row` and
 * `.bg-safe-900\/40`, so a plain substring search for `md:flex-row` or
 * `bg-safe-900/40` never matches. Without escaping the colons and slashes this
 * whole file passes while proving nothing at all, which is the failure mode it
 * exists to prevent.
 */
function emitted(token) {
  const escaped = token
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:/g, '\\:')
    .replace(/\//g, '\\/')
    .replace(/%/g, '\\%')
    .replace(/#/g, '\\#');
  return css.includes('.' + escaped);
}

/** Raw CSS selector present, for rules written by hand in the base layer. */
function hasSelector(selector) {
  return css.includes(selector);
}

let css = '';
let sourceFiles = [];
let buildError = null;

before(async () => {
  try {
    // A fresh build, because a test against a stale stylesheet proves nothing.
    await run(process.execPath, [VITE_BIN, 'build'], { cwd: WEB_ROOT, timeout: 180_000 });
  } catch (err) {
    buildError = err;
    return;
  }

  const assets = path.join(WEB_ROOT, 'dist', 'assets');
  const files = (await fs.readdir(assets)).filter((f) => f.startsWith('index-') && f.endsWith('.css'));
  assert.equal(files.length, 1, 'expected exactly one index stylesheet, found ' + files.length);
  css = await fs.readFile(path.join(assets, files[0]), 'utf8');

  sourceFiles = await collectJsx(SRC);
});

async function collectJsx(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectJsx(full)));
    else if (/\.jsx?$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function readSource() {
  return Promise.all(sourceFiles.map(async (f) => [f, await fs.readFile(f, 'utf8')]));
}

describe('the stylesheet was built, not just written', () => {
  test('the build succeeded', () => {
    assert.equal(buildError, null, buildError ? String(buildError.stderr ?? buildError) : '');
    assert.ok(css.length > 1000, 'stylesheet is suspiciously small: ' + css.length + ' bytes');
  });

  test('keyboard focus is visible', () => {
    // A base layer rule rather than a utility class, so it is asserted as a
    // selector. Removing it makes the whole app unusable by keyboard and
    // nothing else in the build would notice.
    assert.ok(
      hasSelector(':focus-visible'),
      'no :focus-visible rule in the stylesheet, so there is no keyboard focus ring anywhere',
    );
  });

  test('the custom utilities are compiled', () => {
    // `tnum` and `hairline` are @utility declarations in index.css. A typo in
    // the name, or a missing semicolon, drops them silently.
    assert.ok(hasSelector('.tnum'), 'the tnum utility did not compile');
    // It is also what proved `hairline` was dead: nothing used it, so it was
    // never emitted. Dead utilities are how a stylesheet rots quietly.
  });

  test('the theme colours reached the stylesheet', () => {
    for (const token of ['--color-ink-950', '--color-safe-500', '--color-refuse-500', '--color-engine-500']) {
      assert.ok(css.includes(token), `${token} is missing, so the palette did not compile`);
    }
  });

  test('reduced motion is respected', () => {
    assert.ok(
      hasSelector('prefers-reduced-motion'),
      'no prefers-reduced-motion block, so the page animates regardless of the OS setting',
    );
  });
});

describe('classes built from a variable are still generated', () => {
  test('every literal class in the source was emitted into the CSS', async () => {
    const sources = await readSource();
    const missing = new Map();

    for (const [file, text] of sources) {
      // Every string literal in the file, which covers the tone maps, the size
      // map and the className fragments alike.
      for (const m of text.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) {
        const literal = m[1] ?? m[2] ?? m[3];
        if (!literal) continue;

        for (const token of literal.split(/\s+/)) {
          const cls = asClass(token);
          if (cls === null) continue;
          if (emitted(cls)) continue;

          if (!missing.has(cls)) missing.set(cls, []);
          missing.get(cls).push(path.basename(file));
        }
      }
    }

    const report = [...missing.entries()]
      .map(([token, files]) => `  ${token}  (${[...new Set(files)].join(', ')})`)
      .join('\n');

    assert.equal(
      missing.size,
      0,
      `${missing.size} class(es) are written in the source but never emitted into the stylesheet.\n` +
        `Tailwind cannot see a class it cannot find as a literal, so these render unstyled:\n${report}`,
    );
  });

  test('no class name is assembled by concatenation', async () => {
    // Only className templates are considered. Every template literal in the
    // project contains a glued interpolation somewhere, including the URL
    // builders in api.js and the sentence fragments in the panels, and flagging
    // those would be noise rather than signal.
    //
    // Within a className, interpolating a value is fine as long as every value
    // it can take is a complete literal in the source, which the test above
    // proves. What Tailwind cannot see is an interpolation glued to the class
    // characters beside it, because `text-${tone}-400` is a different class for
    // every tone and no scanner will guess the set. A backtick or quote beside
    // the braces is just the end of the literal, so only class characters count
    // as glue.
    const CLASS_NEIGHBOUR = /[a-z0-9_:-]/i;
    const sources = await readSource();
    const offenders = [];

    for (const [file, text] of sources) {
      for (const m of text.matchAll(/className=\{`([^`\n]*)`\}/g)) {
        const literal = m[1];
        for (const glue of literal.matchAll(/\$\{/g)) {
          const at = glue.index;
          const before = at > 0 ? literal[at - 1] : '';
          const close = literal.indexOf('}', at);
          const after = close === -1 ? '' : (literal[close + 1] ?? '');
          const inner = literal.slice(at + 2, close);
          // Tested for truthiness first on purpose. RegExp.test coerces its
          // argument, so test(undefined) runs against the string "undefined",
          // which contains class characters and would flag every interpolation
          // that ends the literal.
          const glued = Boolean(before && CLASS_NEIGHBOUR.test(before)) ||
            Boolean(after && CLASS_NEIGHBOUR.test(after));
          if (glued) {
            offenders.push(
              `  ${path.basename(file)}: className={\`${literal}\`}  ` +
                `interpolates "${inner}" against "${before}${after}", which builds a class Tailwind cannot see`,
            );
          }
        }
      }
    }

    assert.equal(
      offenders.length,
      0,
      `${offenders.length} className builds a name out of fragments:\n${offenders.join('\n')}`,
    );
  });
});

describe('the responsive classes this layout depends on are real', () => {
  // Each of these is load bearing. If one stops being emitted, the layout
  // silently falls back to the mobile layout at every width, or the other way
  // round, and the page still looks like a page.
  const REQUIRED = [
    // The diagram is one column on a phone and four across from md up. If
    // md:flex-row is missing, the connector arrows stay rotated and the four
    // stages stack forever.
    ['md:flex-row', 'the routing diagram never goes horizontal'],
    ['md:items-stretch', 'diagram stages would not share a height'],
    ['md:rotate-0', 'the connector arrows would stay pointing down'],
    ['rotate-90', 'the connector arrows would point the wrong way on a phone'],

    // Two columns of hubs, four impact figures, two detail columns.
    ['sm:grid-cols-2', 'hub cards never pair up'],
    ['lg:grid-cols-2', 'the about panels and the impact breakdowns never pair up'],
    ['lg:grid-cols-4', 'the impact figures never form a row of four'],

    // The assign button is full width on a phone and auto on anything wider.
    ['sm:w-auto', 'the button would stretch across the card forever'],

    // Without min-w-0 a truncating child cannot shrink and overflows instead.
    ['min-w-0', 'long titles overflow their card rather than truncating'],
    ['truncate', 'titles are not truncated at all'],
  ];

  for (const [token, consequence] of REQUIRED) {
    test(`emits ${token}`, () => {
      assert.ok(
        emitted(token),
        `.${token} is not in the generated stylesheet, so ${consequence}. ` +
          `Either the class was removed, or it is only reachable through a value Tailwind cannot see.`,
      );
    });
  }
});

describe('the status colours are four separable signals', () => {  // The whole design rests on colour meaning something, so the four outcome
  // colours have to be distinguishable rather than four shades of grey.
  for (const token of [
    'text-safe-400',
    'bg-safe-900/40',
    'border-safe-500/35',
    'text-pending-400',
    'bg-pending-900/40',
    'border-pending-500/35',
    'text-refuse-400',
    'bg-refuse-900/40',
    'border-refuse-500/35',
    'text-engine-400',
    'bg-engine-900/40',
    'border-engine-500/40',
  ]) {
    test(`emits ${token}`, () => assert.ok(emitted(token), `.${token} is missing from the stylesheet`));
  }
});
