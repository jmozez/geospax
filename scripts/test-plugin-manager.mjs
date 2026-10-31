// The plugin manager's logic (web/src/pluginmanager.ts): which plugins each tab lists, version
// comparison, what can be upgraded, reinstalled or removed, the search box and the repository form.
//   node --experimental-strip-types --no-warnings scripts/test-plugin-manager.mjs
import assert from 'node:assert/strict';

const M = await import('../web/src/pluginmanager.ts');

// versions: numbers as numbers, a pre-release before its release (same rules as the engine)
assert.equal(M.versionCmp('1.10', '1.9'), 1);
assert.equal(M.versionCmp('1.2', '1.2.0'), 0);
assert.equal(M.versionCmp('v2.0.1', '2.0.0'), 1);
assert.equal(M.versionCmp('1.2.0-beta', '1.2.0'), -1);
assert.equal(M.versionCmp('0.9', '1.0'), -1);
assert.equal(M.versionCmp('1.0-rc2', '1.0-rc1'), 1);

const STATE = '/home/u/.local/share/geospax/plugins';
const plugin = (id, extra = {}) => ({
  id, name: id.replace(/-/g, ' '), version: '1.0', description: `${id} does things`, source: 'native', kind: 'python',
  runnable: true, path: `${STATE}/${id}`, tools: [{ id: 't', name: 'T', summary: '', group: '' }], commands: [], ...extra,
});
const offer = (id, version, extra = {}) => ({ id, name: id.replace(/-/g, ' '), version, description: `${id} from the repo`, source: 'native', download: `${id}-${version}.zip`, repo: 'Local', ...extra });

const installed = [
  plugin('buffer-tools', { version: '1.0' }),
  plugin('agriculture', { default: true, path: '/usr/share/geospax/plugins/agriculture' }),
  plugin('dev-copy', { version: '2.0', path: '/src/dev-copy' }),
  plugin('gsx', { builtin: true }),
  plugin('gsx-lib', { library: true }),
  plugin('old-qgis', { source: 'qgis', runnable: false, needs: 'PyQt' }),
];
const offers = [
  offer('buffer-tools', '1.2', { tags: ['vector', 'buffer'], author: 'Kila Gere' }),
  offer('dev-copy', '1.5'),
  offer('agriculture', '9.0'),
  offer('heatmap', '0.3', { tags: ['raster'] }),
  offer('nightly-thing', '0.0.1', { experimental: true }),
];
let rows = M.buildRows(installed, ['old-qgis'], offers, STATE);
const by = Object.fromEntries(rows.map((r) => [r.id, r]));

// built-in tool sets and libraries are part of GeoSpaX: never in the manager
assert.ok(!by.gsx && !by['gsx-lib']);
// experimental offers hidden unless asked for
assert.ok(!by['nightly-thing']);
assert.ok(M.buildRows(installed, [], offers, STATE, true).some((r) => r.id === 'nightly-thing'));
// an installed plugin with a newer offer is upgradeable; a development copy newer than the offer is not
assert.equal(by['buffer-tools'].upgradeable, true);
assert.equal(by['dev-copy'].upgradeable, false);
assert.equal(by['dev-copy'].newer, true);
// default plugins update with GeoSpaX, never from a repository
assert.equal(by.agriculture.available, undefined);
assert.equal(by.agriculture.upgradeable, false);
assert.equal(by.agriculture.removable, false);
// switched off, still installed
assert.equal(by['old-qgis'].enabled, false);
assert.ok(by['old-qgis'].installed);
// only plugins in the state folder can be removed from here
assert.equal(by['buffer-tools'].removable, true);
assert.equal(by['dev-copy'].removable, false);
// offered, not installed
assert.ok(!by.heatmap.installed && by.heatmap.available);
// sorted by name
assert.deepEqual(rows.map((r) => r.name), [...rows.map((r) => r.name)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));

// tabs
const ids = (tab, q) => M.filterRows(rows, tab, q).map((r) => r.id).sort();
assert.deepEqual(ids('all'), ['agriculture', 'buffer-tools', 'dev-copy', 'heatmap', 'old-qgis']);
assert.deepEqual(ids('installed'), ['agriculture', 'buffer-tools', 'dev-copy', 'old-qgis']);
assert.deepEqual(ids('not-installed'), ['heatmap']);
assert.deepEqual(ids('upgradeable'), ['buffer-tools']);
assert.deepEqual(M.tabCounts(rows), { all: 5, installed: 4, 'not-installed': 1, upgradeable: 1, zip: null, settings: null });
// search: name, id, description, author and tags; every word must match
assert.deepEqual(ids('all', 'BUFFER'), ['buffer-tools']);
assert.deepEqual(ids('all', 'raster'), ['heatmap']);
assert.deepEqual(ids('all', 'kila'), ['buffer-tools']);
assert.deepEqual(ids('all', 'does things'), ['agriculture', 'buffer-tools', 'dev-copy', 'old-qgis']);
assert.deepEqual(ids('installed', 'heatmap'), []);
assert.deepEqual(ids('all', 'nothing-like-this'), []);

// details buttons
assert.deepEqual(M.actionsFor(by['buffer-tools']), ['upgrade', 'uninstall']);
assert.deepEqual(M.actionsFor(by.heatmap), ['install']);
assert.deepEqual(M.actionsFor(by['dev-copy']), ['reinstall']);
assert.deepEqual(M.actionsFor(by.agriculture), []);
assert.deepEqual(M.actionsFor(by['old-qgis']), ['uninstall']);
const same = M.buildRows([plugin('heatmap', { version: '0.3' })], [], offers, STATE).find((r) => r.id === 'heatmap');
assert.deepEqual(M.actionsFor(same), ['reinstall', 'uninstall']);

// repository form
const repos = [{ name: 'Local', url: '/srv/repo/plugins.json', enabled: true }];
assert.match(M.checkRepo('X', '', repos), /URL/);
assert.match(M.checkRepo('X', ' /srv/repo/plugins.json ', repos), /already/);
assert.match(M.checkRepo('', 'https://x.org/plugins.json', repos), /name/);
assert.equal(M.checkRepo('X', 'https://x.org/plugins.json', repos), null);

// the tabs, in QGIS's order
assert.deepEqual(M.PM_TABS.map((t) => t.id), ['all', 'installed', 'not-installed', 'upgradeable', 'zip', 'settings']);

console.log('plugin manager logic: all checks passed');
