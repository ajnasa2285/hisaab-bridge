// Runs the ledger check over ledger files, for a person: on COPIES of ledgers (opening one sets up its
// schema if missing, as the app does; it changes no row). Prints row numbers and kinds of problem only.
//
//   node src/ledger/check-files.js jcb=<file> site=<file> supplier=<file>
//   add <name>.key=ed25519:<base64> (the public key in the agent's card) to check the receipts' signatures too
//
// Exit 0: everything agrees. 1: something does not. 2: wrong use, or a part could not be checked.

import { pathToFileURL } from 'node:url';
import { publicKeyFromText } from '../protocol/keys.js';
import { checkLedgers } from './integrity.js';
import { openLedger } from './store.js';

/**
 * @param {string[]} args @param {(line: string) => void} print
 * @returns {Promise<number>} the exit code
 */
export async function checkFiles(args, print) {
  const pairs = args.map((a) => { const i = a.indexOf('='); return i < 1 ? ['', ''] : [a.slice(0, i), a.slice(i + 1)]; });
  const files = pairs.filter(([k]) => k && !k.endsWith('.key'));
  const keyOf = new Map(pairs.filter(([k]) => k.endsWith('.key')).map(([k, v]) => [k.slice(0, -'.key'.length), v]));
  if (files.length === 0 || pairs.some(([k, v]) => !k || !v)) {
    print('use: node src/ledger/check-files.js jcb=<file> site=<file> supplier=<file> [<name>.key=ed25519:<base64>]');
    return 2;
  }
  const ledgers = files.map(([name, file]) => ({ name, ledger: openLedger(file) }));
  try {
    // A ledger does not store its own id or its peers: its signed messages and orders name them.
    const known = ledgers.map(({ name, ledger }) => {
      const orders = /** @type {{order_id: string, counterparty: string}[]} */ (/** @type {unknown} */ (ledger.orders()));
      const signed = orders.flatMap((o) => ledger.events(o.order_id)).find((e) => e.direction !== 'local');
      return { name, ledger, id: signed ? String(signed.direction === 'out' ? signed.body.from : signed.body.to) : null, counterparties: new Set(orders.map((o) => o.counterparty)) };
    });
    // With no signed row left, not even the agent's id can be read: that is not a pass.
    const unnamed = known.filter((a) => a.id === null).map((a) => a.name);
    for (const name of unnamed) print(`${name}: no signed row, so it cannot be compared`);
    const keys = new Map(known.flatMap((a) => (keyOf.has(a.name) ? [/** @type {[string, import('node:crypto').KeyObject]} */ ([String(a.id), publicKeyFromText(/** @type {string} */ (keyOf.get(a.name)))])] : [])));
    const agents = known.map((a) => ({ name: a.name, id: a.id ?? `unknown:${a.name}`, ledger: a.ledger, peers: new Map([...a.counterparties].map((id) => [id, { publicKey: keys.get(id) }])) }));
    let unchecked = unnamed.length;
    const r = await checkLedgers(agents, { onError: (name, e) => { unchecked += 1; print(`${name}: could not be checked (${e instanceof Error ? e.name : 'error'})`); } });
    print(`${agents.length} ledgers, ${r.receipts} receipts compared, ${r.signaturesChecked} signatures checked${keys.size ? '' : ' (no public keys given)'}`);
    for (const f of r.failures) print(`${f.text}${f.orderId ? `, order ${f.orderId}` : ''}`);
    print(r.failures.length ? `NOT OK: ${r.failures.length} problem(s)` : unchecked ? 'NOT CHECKED: see above' : 'OK: chains intact, every receipt agrees');
    return r.failures.length ? 1 : unchecked ? 2 : 0;
  } finally {
    for (const { ledger } of ledgers) ledger.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await checkFiles(process.argv.slice(2), (l) => { console.log(l); });
}
