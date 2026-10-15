/**
 * Ari RTMP — static consistency checks (run in CI).
 * - package.json is valid JSON
 * - every public/*.html inline <script> parses
 * - nginx/edge templates only use known placeholders
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  failures += 1;
}
function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

// 1) package.json
try {
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  ok('package.json is valid JSON');
} catch (e) {
  fail(`package.json: ${e.message}`);
}

// 2) HTML inline scripts
const publicDir = join(root, 'public');
for (const file of readdirSync(publicDir).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(join(publicDir, file), 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  let bad = false;
  for (const b of blocks) {
    try {
      // eslint-disable-next-line no-new-func
      new Function(b[1]);
    } catch (e) {
      fail(`${file}: inline script does not parse: ${e.message}`);
      bad = true;
    }
  }
  if (!bad) ok(`${file}: ${blocks.length} inline script block(s) parse`);
}

// 3) Nginx/edge template placeholders
const KNOWN = new Set([
  '__APP_UPSTREAM__',
  '__HLS_ROOT__',
  '__SERVER_NAME__',
  '__INTERNAL_TOKEN__',
  '__TRANSCODE_SCRIPT__',
  '__RTMP_INGEST_URL__',
  '__SSL_CERT__',
  '__SSL_KEY__',
  '__EDGE_SERVER_NAME__',
  '__ORIGIN_URL__',
  '__ORIGIN_HOST__',
]);
const nginxDir = join(root, 'nginx');
for (const file of readdirSync(nginxDir).filter((f) => f.endsWith('.template'))) {
  const text = readFileSync(join(nginxDir, file), 'utf8');
  const found = new Set((text.match(/__[A-Z_]+__/g) || []));
  const unknown = [...found].filter((p) => !KNOWN.has(p));
  if (unknown.length) fail(`${file}: unknown placeholders ${unknown.join(', ')}`);
  else ok(`${file}: placeholders OK (${[...found].length})`);
}

// 4) The compiled Nginx build must enable every module the templates use.
//    auth_request (ngx_http_auth_request_module) is NOT built by default and
//    gates HLS playback, so its absence breaks token enforcement.
const REQUIRED_CONFIGURE_FLAGS = [
  '--with-http_auth_request_module',
  '--with-http_ssl_module',
  '--with-http_v2_module',
];
for (const rel of ['install.sh', 'docker/nginx/Dockerfile']) {
  const text = readFileSync(join(root, rel), 'utf8');
  const missing = REQUIRED_CONFIGURE_FLAGS.filter((f) => !text.includes(f));
  if (missing.length) fail(`${rel}: Nginx build missing ${missing.join(', ')}`);
  else ok(`${rel}: Nginx configure flags include required modules`);
}

if (failures > 0) {
  console.error(`\nStatic checks failed: ${failures} problem(s).`);
  process.exit(1);
}
console.log('\nStatic checks passed.');
