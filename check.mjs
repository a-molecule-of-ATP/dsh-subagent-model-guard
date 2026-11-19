// Repository self-check. Runs in CI and locally; needs no DSH host.
//
// It checks the invariants that break silently: a setting that is documented but
// never shipped, a vendored import missing from the package, a locale that does
// not parse, a doc pointing at an image that is not in the repo.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
let problems = 0;
const fail = (message) => { problems += 1; console.error(`  x ${message}`); };
const pass = (message) => console.log(`  ok ${message}`);

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

// 1. every @deepseek-ai import must exist on disk and be listed in `files`
const source = readFileSync(path.join(root, 'index.js'), 'utf8');
const vendored = [...new Set([...source.matchAll(/from\s+'(@deepseek-ai\/[^']+)'/g)].map((m) => m[1]))];
for (const name of vendored) {
  const rel = `node_modules/${name}`;
  if (!existsSync(path.join(root, rel))) fail(`${name} is imported but not vendored`);
  const listed = (pkg.files ?? []).some((entry) => entry === rel || entry.startsWith(`${rel}/`));
  if (!listed) fail(`${name} is imported but package.json "files" omits ${rel}`);
}
if (vendored.length > 0) pass(`${vendored.length} vendored import(s) shipped`);

// 2. every configured setting must be documented
const mod = await import(pathToFileURL(path.join(root, 'index.js')).href);
const fields = Object.keys(mod.Config?.dict ?? {});
const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
const undocumented = fields.filter((field) => !readme.includes(field));
if (undocumented.length > 0) fail(`settings missing from README: ${undocumented.join(', ')}`);
else pass(`${fields.length} settings documented`);

// 3. locales parse and carry a title + description
for (const lang of ['zh', 'en']) {
  const file = path.join(root, 'locale', `${lang}.json`);
  let dict;
  try {
    dict = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`locale/${lang}.json does not parse: ${error.message}`);
    continue;
  }
  if (!dict.meta?.title) fail(`locale/${lang}.json has no meta.title`);
  if (!dict.meta?.description) fail(`locale/${lang}.json has no meta.description`);
}
pass('locales parse');

// 4. documented images must exist in the repository
const docs = path.join(root, 'docs');
if (existsSync(docs)) {
  for (const name of readdirSync(docs).filter((n) => n.endsWith('.md'))) {
    const text = readFileSync(path.join(docs, name), 'utf8');
    for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      if (!existsSync(path.join(docs, match[1]))) fail(`docs/${name} references missing ${match[1]}`);
    }
  }
  pass('doc images resolve');
}

console.log(problems === 0 ? '\nSELF-CHECK OK' : `\n${problems} PROBLEM(S)`);
process.exitCode = problems === 0 ? 0 : 1;
