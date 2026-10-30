// The site names one agent has been told about (docs/BUILD2.md "Two requests, unknown site names").
// When a request names a site the agent does not know, a person says which site it is, once: a short
// name then points at the full site's name, and a new site points at itself. Kept per agent in its own
// SQLite file (`<dataDir>/<name>.sites.db`, in memory without a data dir), apart from the ledger, so
// events stay as they are. Append-only: a forgotten name is a row of its own, the latest row counts.
// Code compares trimmed and case-folded names, exactly; nothing here guesses that two names are the same.

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS site_names (
     id       INTEGER PRIMARY KEY,
     name_key TEXT NOT NULL,
     name     TEXT NOT NULL,
     site     TEXT,
     by_role  TEXT NOT NULL,
     at       TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS site_names_key ON site_names (name_key, id)`,
  `CREATE TRIGGER IF NOT EXISTS site_names_no_update BEFORE UPDATE ON site_names BEGIN SELECT RAISE(ABORT, 'append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS site_names_no_delete BEFORE DELETE ON site_names BEGIN SELECT RAISE(ABORT, 'append-only'); END`,
];

/** The form two names are compared in. @param {string} name */
export const siteKey = (name) => name.normalize('NFC').trim().toLowerCase();

/** @param {{file?: string, now: () => number}} o */
export function openSiteNames(o) {
  const db = new DatabaseSync(o.file ?? ':memory:');
  for (const sql of SCHEMA) db.exec(sql);
  const q = {
    insert: db.prepare('INSERT INTO site_names (name_key, name, site, by_role, at) VALUES (?, ?, ?, ?, ?)'),
    latest: db.prepare('SELECT site FROM site_names WHERE name_key = ? ORDER BY id DESC LIMIT 1'),
    live: db.prepare('SELECT s.site, s.at FROM site_names s WHERE s.site IS NOT NULL AND s.id = (SELECT MAX(id) FROM site_names WHERE name_key = s.name_key) ORDER BY s.id'),
  };
  const nowIso = () => new Date(o.now()).toISOString();
  /** @param {string} name @returns {string | null} the full site's name a saved name points at */
  const lookup = (name) => /** @type {{site: string | null} | undefined} */ (q.latest.get(siteKey(name)))?.site ?? null;
  return {
    lookup,
    /**
     * Saves what a person said a name is. The first answer stands until it is forgotten, so two people
     * asked at the same moment leave one meaning.
     * @param {string} name @param {string} site @param {string} role
     */
    save(name, site, role) {
      if (lookup(name) === null) q.insert.run(siteKey(name), name.trim(), site.trim(), role, nowIso());
    },
    /** @param {string} name @param {string} role @returns {boolean} whether it was saved */
    forget(name, role) {
      if (lookup(name) === null) return false;
      q.insert.run(siteKey(name), name.trim(), null, role, nowIso());
      return true;
    },
    /** Every site a saved name points at, oldest first. @returns {{site: string, at: string}[]} */
    sites: () => /** @type {any[]} */ (q.live.all()).map((r) => ({ site: r.site, at: r.at })),
    close() { db.close(); },
  };
}

/** @typedef {ReturnType<typeof openSiteNames>} SiteNames */
