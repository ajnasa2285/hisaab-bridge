// What someone with write access to a ledger's file can do: drop the triggers, change or delete rows,
// and recompute every later hash the way src/ledger/store.js does. The chain then verifies.

import { createHash } from 'node:crypto';
import { canonicalize } from '../../src/protocol/canonical.js';

/**
 * Changes one row's body and recomputes that row's hash and every later one.
 * @param {{db: import('node:sqlite').DatabaseSync}} ledger @param {number} seq
 * @param {(body: any) => void} change
 */
export function rewriteRow(ledger, seq, change) {
  ledger.db.exec('DROP TRIGGER IF EXISTS events_no_update');
  const rows = /** @type {any[]} */ (ledger.db.prepare('SELECT * FROM events ORDER BY seq').all());
  const update = ledger.db.prepare('UPDATE events SET body_json = ?, prev_hash = ?, hash = ? WHERE seq = ?');
  let prev = '0'.repeat(64);
  for (const r of rows) {
    if (r.seq < seq) { prev = r.hash; continue; }
    const body = JSON.parse(r.body_json);
    if (r.seq === seq) change(body);
    const content = canonicalize({ seq: r.seq, order_id: r.order_id, direction: r.direction, type: r.type, msg_id: r.msg_id, body, at: r.at });
    const hash = createHash('sha256').update(prev).update(content).digest('hex');
    update.run(JSON.stringify(body), prev, hash, r.seq);
    prev = hash;
  }
}

/**
 * Deletes every row from this one on. The rows before it still verify.
 * @param {{db: import('node:sqlite').DatabaseSync}} ledger @param {number} fromSeq
 */
export function deleteFrom(ledger, fromSeq) {
  ledger.db.exec('DROP TRIGGER IF EXISTS events_no_delete');
  ledger.db.prepare('DELETE FROM events WHERE seq >= ?').run(fromSeq);
}
