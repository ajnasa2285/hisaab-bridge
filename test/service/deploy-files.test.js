// The server's files for the separate services say what deploy/aws/SPLIT.md says. (Caddyfile.services is
// also run as the front door of test/service/split.test.js.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_BODY_BYTES } from '../../src/transport/a2a.js';

const read = (/** @type {string} */ f) => readFileSync(new URL(`../../deploy/aws/${f}`, import.meta.url), 'utf8');

test('each agent\'s routes go to its own port, /internal/ goes nowhere, and the old Caddyfile is still there for going back', () => {
  const c = read('Caddyfile.services');
  /** @param {string} name */
  const block = (name) => new RegExp(`handle @${name} \\{\\s*request_body \\{\\s*max_size (\\d+)MB\\s*\\}\\s*reverse_proxy 127\\.0\\.0\\.1:\\{\\$(\\w+):(\\d+)\\}`).exec(c);
  for (const [name, port, variable] of [['jcb', '8081', 'HB_PORT_JCB'], ['site', '8082', 'HB_PORT_SITE'], ['supplier', '8083', 'HB_PORT_SUPPLIER']]) {
    assert.match(c, new RegExp(`@a2a_${name} path /agents/${name}/a2a\\n`));
    assert.match(c, new RegExp(`@${name} path /agents/${name}/\\*\\n`));
    const a2a = block(`a2a_${name}`);
    assert.ok(a2a && Number(a2a[1]) * 1000 * 1000 >= MAX_BODY_BYTES, `${name}'s a2a takes a whole photo`);
    assert.deepEqual([a2a[2], a2a[3]], [variable, port]);
    const rest = block(name);
    assert.ok(rest);
    assert.deepEqual([rest[1], rest[2], rest[3]], ['1', variable, port]);
    assert.ok(c.indexOf(`@a2a_${name} path`) < c.indexOf(`@${name} path`), 'the a2a route first');
  }
  const app = block('app');
  assert.ok(app);
  assert.deepEqual([app[1], app[2], app[3]], ['1', 'HB_PORT', '8080']);
  assert.doesNotMatch(c, /path[^\n]*\/internal/);
  assert.doesNotMatch(c, /file_server|browse/);
  assert.match(c, /respond "Not found" 404/);
  assert.match(read('rollback-to-one.sh'), /deploy\/aws\/Caddyfile" \/etc\/caddy\/Caddyfile/);
});

test('each service runs as its own user, can write only its own folder, and reads its own settings', () => {
  const agent = read('hisaab-agent@.service');
  for (const line of ['User=hisaab-%i', 'Group=hisaab-%i', 'EnvironmentFile=/etc/hisaab/%i.env', 'Environment=HB_AGENT=%i', 'ExecStart=/usr/bin/node src/service/agent.js', 'ReadWritePaths=/var/lib/hisaab-%i', 'InaccessiblePaths=-/var/lib/hisaab', 'ProtectSystem=strict', 'NoNewPrivileges=true', 'UMask=0077']) {
    assert.ok(agent.split('\n').includes(line), line);
  }
  const router = read('hisaab-router.service');
  for (const line of ['User=hisaab-router', 'EnvironmentFile=/etc/hisaab/router.env', 'ExecStart=/usr/bin/node src/service/router.js', 'ReadWritePaths=/var/lib/hisaab-router', 'InaccessiblePaths=-/var/lib/hisaab', 'ProtectSystem=strict', 'NoNewPrivileges=true']) {
    assert.ok(router.split('\n').includes(line), line);
  }
  assert.ok(read('hisaab.service').includes('ExecStart=/usr/bin/node src/main.js'), 'the way back is still there');
  const split = read('split-services.sh');
  assert.match(split, /--copy/);
  assert.match(split, /caddy validate/);
  assert.doesNotMatch(split, /rm -rf/, 'the old folder is not removed by the script');
  assert.doesNotMatch(read('rollback-to-one.sh'), /rm -rf/);
});
