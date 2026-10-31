// The plugin manager's logic (docs/PLUGINS.md §Manager), kept free of the DOM so Node can test it
// (scripts/test-plugin-manager.mjs): which plugins each tab lists, version comparison, what can be
// upgraded, switched off or removed. The pane in plugins.ts draws it in the style of QGIS's
// "Manage and Install Plugins" dialogue.
import type { PluginInfo } from './plugins';

export type PmTab = 'all' | 'installed' | 'not-installed' | 'upgradeable' | 'zip' | 'settings';

export const PM_TABS: { id: PmTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'installed', label: 'Installed' },
  { id: 'not-installed', label: 'Not installed' },
  { id: 'upgradeable', label: 'Upgradeable' },
  { id: 'zip', label: 'Install from ZIP' },
  { id: 'settings', label: 'Settings' },
];

/** One package a plugin repository offers (crates/engine/src/plugin_repos.rs). */
export interface RepoPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  license?: string;
  source: string;
  download: string;
  sha256?: string;
  tags?: string[];
  experimental?: boolean;
  repo: string;
}

export interface Repo {
  name: string;
  url: string;
  enabled: boolean;
}

export interface ManagerConfig {
  disabled: string[];
  repos: Repo[];
  check_updates: boolean;
  show_experimental: boolean;
}

export interface RepoIndex {
  fetched: number;
  plugins: RepoPlugin[];
  errors: string[];
}

/** A line in the manager's list: an installed plugin, a repository offer, or both. */
export interface PmRow {
  id: string;
  name: string;
  description: string;
  source: string;
  installed?: PluginInfo;
  available?: RepoPlugin;
  enabled: boolean;
  /** the repository has a newer version than the one installed */
  upgradeable: boolean;
  /** the installed copy is newer than the repository's (a development build) */
  newer: boolean;
  /** installed into the state folder, so Uninstall may remove it */
  removable: boolean;
  isDefault: boolean;
}

/** Numbers compare as numbers (1.10 > 1.9); a pre-release sorts before its release. Same rules as the engine. */
export function versionCmp(a = '', b = ''): number {
  const strip = (s: string) => s.trim().replace(/^[vV]/, '');
  const split = (s: string): [string, string | null] => {
    const i = s.indexOf('-');
    return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
  };
  const [an, ap] = split(strip(a));
  const [bn, bp] = split(strip(b));
  const sa = an.split(/[._+]/);
  const sb = bn.split(/[._+]/);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i] ?? '0';
    const y = sb[i] ?? '0';
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    const o = !isNaN(nx) && !isNaN(ny) ? Math.sign(nx - ny) : x < y ? -1 : x > y ? 1 : 0;
    if (o) return o;
  }
  if (ap === null && bp === null) return 0;
  if (ap !== null && bp === null) return -1;
  if (ap === null && bp !== null) return 1;
  return ap! < bp! ? -1 : ap! > bp! ? 1 : 0;
}

/** Merge what is installed with what the repositories offer. Built-in tool sets and libraries are
 *  part of GeoSpaX and never listed. */
export function buildRows(
  installed: PluginInfo[],
  disabled: string[],
  offers: RepoPlugin[],
  stateDir: string | undefined,
  showExperimental = false,
): PmRow[] {
  const rows = new Map<string, PmRow>();
  for (const p of installed) {
    if (p.builtin || p.library) continue;
    rows.set(p.id, {
      id: p.id,
      name: p.name,
      description: p.description,
      source: p.source,
      installed: p,
      enabled: !disabled.includes(p.id),
      upgradeable: false,
      newer: false,
      removable: !p.default && !!stateDir && p.path.startsWith(stateDir),
      isDefault: !!p.default,
    });
  }
  for (const o of offers) {
    if (o.experimental && !showExperimental) continue;
    const r = rows.get(o.id);
    if (r) {
      if (r.installed?.builtin || r.isDefault) continue;
      r.available = o;
      const c = versionCmp(o.version, r.installed?.version ?? '0');
      r.upgradeable = c > 0;
      r.newer = c < 0;
    } else if (!installed.some((p) => p.id === o.id)) {
      rows.set(o.id, {
        id: o.id,
        name: o.name,
        description: o.description,
        source: o.source,
        available: o,
        enabled: false,
        upgradeable: false,
        newer: false,
        removable: false,
        isDefault: false,
      });
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** The rows a tab shows, narrowed by the search box (name, id, description, author, tags). */
export function filterRows(rows: PmRow[], tab: PmTab, query = ''): PmRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (tab === 'installed' && !r.installed) return false;
    if (tab === 'not-installed' && r.installed) return false;
    if (tab === 'upgradeable' && !r.upgradeable) return false;
    if (!q) return true;
    const hay = [r.name, r.id, r.description, r.installed?.author, r.available?.author, ...(r.available?.tags ?? [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  });
}

export function tabCounts(rows: PmRow[]): Record<PmTab, number | null> {
  return {
    all: rows.length,
    installed: rows.filter((r) => r.installed).length,
    'not-installed': rows.filter((r) => !r.installed).length,
    upgradeable: rows.filter((r) => r.upgradeable).length,
    zip: null,
    settings: null,
  };
}

/** The actions the details panel offers for a row, in order. */
export function actionsFor(r: PmRow): ('install' | 'upgrade' | 'reinstall' | 'uninstall')[] {
  const out: ('install' | 'upgrade' | 'reinstall' | 'uninstall')[] = [];
  if (!r.installed && r.available) out.push('install');
  if (r.installed && r.available && r.upgradeable) out.push('upgrade');
  if (r.installed && r.available && !r.upgradeable) out.push('reinstall');
  if (r.installed && r.removable) out.push('uninstall');
  return out;
}

/** A repository row from the Settings form, or a reason it cannot be saved. */
export function checkRepo(name: string, url: string, repos: Repo[]): string | null {
  if (!url.trim()) return 'Give the repository URL (or a path to its plugins.json)';
  if (repos.some((r) => r.url.trim() === url.trim())) return 'That repository is already in the list';
  if (!name.trim()) return 'Give the repository a name';
  return null;
}
