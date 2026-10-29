// What the WhatsApp side remembers: which message ids have been handled (Meta re-delivers a
// webhook when it is not answered quickly) and when each known person last wrote on each line
// (WhatsApp allows free-form replies only within 24 hours of that). Unknown senders are never
// written here. Also which notices could not be sent because that window was closed (by order
// reference and text key only, never the text): told again from the ledger when the person next writes.

import { DatabaseSync } from 'node:sqlite';

export const WINDOW_MS = 24 * 60 * 60 * 1000;

/** @param {string} file a path, or ':memory:' */
export function openWaStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS wa_seen (msg_id TEXT PRIMARY KEY, at_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS wa_window (line TEXT NOT NULL, phone TEXT NOT NULL, last_in_ms INTEGER NOT NULL, PRIMARY KEY (line, phone));
    CREATE TABLE IF NOT EXISTS wa_missed (line TEXT NOT NULL, phone TEXT NOT NULL, ref TEXT NOT NULL, key TEXT NOT NULL, at_ms INTEGER NOT NULL,
      PRIMARY KEY (line, phone, ref, key));
  `);
  const insertMissed = db.prepare('INSERT OR IGNORE INTO wa_missed (line, phone, ref, key, at_ms) VALUES (?, ?, ?, ?, ?)');
  const listMissed = db.prepare('SELECT ref, key FROM wa_missed WHERE line = ? AND phone = ? ORDER BY at_ms, ref, key');
  const dropMissed = db.prepare('DELETE FROM wa_missed WHERE line = ? AND phone = ?');
  const insertSeen = db.prepare('INSERT OR IGNORE INTO wa_seen (msg_id, at_ms) VALUES (?, ?)');
  const upsertWindow = db.prepare(`INSERT INTO wa_window (line, phone, last_in_ms) VALUES (?, ?, ?)
    ON CONFLICT (line, phone) DO UPDATE SET last_in_ms = max(last_in_ms, excluded.last_in_ms)`);
  const getWindow = db.prepare('SELECT last_in_ms FROM wa_window WHERE line = ? AND phone = ?');

  return {
    /**
     * Records a message id; true only the first time it is seen.
     * @param {string} msgId @param {number} atMs
     */
    firstTime(msgId, atMs) {
      return Number(insertSeen.run(msgId, atMs).changes) === 1;
    },
    /** @param {string} line @param {string} phone @param {number} atMs */
    touch(line, phone, atMs) {
      upsertWindow.run(line, phone, atMs);
    },
    /** @param {string} line @param {string} phone @returns {number | null} */
    lastInbound(line, phone) {
      const row = /** @type {{last_in_ms: number} | undefined} */ (getWindow.get(line, phone));
      return row ? Number(row.last_in_ms) : null;
    },
    /** @param {string} line @param {string} phone @param {number} nowMs */
    windowOpen(line, phone, nowMs) {
      const last = this.lastInbound(line, phone);
      return last !== null && nowMs - last < WINDOW_MS;
    },
    /**
     * A notice about an order (its reference and text key) that could not be sent: the window was closed.
     * @param {string} line @param {string} phone @param {string} ref @param {string} key @param {number} atMs
     */
    missed(line, phone, ref, key, atMs) {
      insertMissed.run(line, phone, ref, key, atMs);
    },
    /**
     * The notices this person missed, taken once: they are gone from the store after this call.
     * @param {string} line @param {string} phone @returns {{ref: string, key: string}[]}
     */
    takeMissed(line, phone) {
      const rows = /** @type {{ref: string, key: string}[]} */ (listMissed.all(line, phone)).map((r) => ({ ref: String(r.ref), key: String(r.key) }));
      if (rows.length) dropMissed.run(line, phone);
      return rows;
    },
    close: () => db.close(),
  };
}
