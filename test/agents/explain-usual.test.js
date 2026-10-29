import { test } from 'node:test';
import assert from 'node:assert/strict';
import { differenceFacts } from '../../src/agents/explain-facts.js';
import { brief, guardViolation } from '../../src/agents/explain.js';
import { usualBooks } from './usual-fixture.js';

test('disputed material bill facts include only unusual historical figures from that party and unit', () => {
  const f = usualBooks();
  try {
    for (const rate of [35000, 38000, 40000]) f.add({ rate });
    for (let i = 0; i < 3; i++) f.add({ rate: 90000, peer: 'agent:supplier-2' });
    const current = f.add({ rate: 50000, quantity: 8000, accepted: false });
    assert.deepEqual(/** @type {any} */ (differenceFacts(f.ledger, current.orderId, 'P-7').context).usualFigures, []);
    current.put('DISPUTE', { bill: current.bill, reason: 'साइट की गिनती अलग है', theirFigure: { qtyHundredths: 5000 } }, current.buy);
    const facts = differenceFacts(f.ledger, current.orderId, 'P-7');
    const c = /** @type {any} */ (facts.context);
    assert.equal(c.usualFigures.length, 2);
    assert.deepEqual(c.usualFigures.map((/** @type {any} */ r) => [r.value, r.n]), [['₹380/बोरी', '3'], ['50 बोरी', '3']]);
    assert.match(facts.figures, /₹380\/बोरी/);
    assert.match(brief(c, 'buyer'), /₹380\/बोरी/);
    assert.equal(guardViolation('पिछले 3 पूरे ऑर्डर में सीमेंट की सामान्य दर ₹380/बोरी थी।', facts.allowedNumbers), null);
    assert.equal(guardViolation('सीमेंट की सामान्य दर ₹381/बोरी थी।', facts.allowedNumbers), 'numbers');
    assert.doesNotMatch(JSON.stringify(c.usualFigures), /900|50000|28%/);
    // Future completed orders cannot retroactively change this bill's original comparison.
    for (let i = 0; i < 3; i++) f.add({ rate: 70000, quantity: 9000 });
    assert.deepEqual(/** @type {any} */ (differenceFacts(f.ledger, current.orderId, 'P-7').context).usualFigures, c.usualFigures);
  } finally { f.close(); }
});

test('a usual bill, unaccepted history and an older dispute add no usual fact', () => {
  const f = usualBooks();
  try {
    for (let i = 0; i < 2; i++) f.add();
    const current = f.add({ rate: 50000, accepted: false });
    current.put('DISPUTE', { bill: current.bill, reason: 'अलग गिनती', theirFigure: { qtyHundredths: 4500 } }, current.buy);
    assert.deepEqual(/** @type {any} */ (differenceFacts(f.ledger, current.orderId, 'P-3').context).usualFigures, []);
    f.add();
    const usual = f.add({ rate: 40000, accepted: false });
    usual.put('DISPUTE', { bill: usual.bill, reason: 'अलग गिनती', theirFigure: { qtyHundredths: 4500 } }, usual.buy);
    assert.deepEqual(/** @type {any} */ (differenceFacts(f.ledger, usual.orderId, 'P-5').context).usualFigures, []);
    const corrected = usual.put('CORRECTION', { replaces: usual.bill, lines: [{ what: 'सीमेंट', qtyHundredths: 9000, ratePaise: 40000, amountPaise: 3600000 }], totalPaise: 3600000, evidence: [] }, usual.sell);
    assert.notEqual(corrected, usual.bill);
    assert.deepEqual(/** @type {any} */ (differenceFacts(f.ledger, usual.orderId, 'P-5').context).usualFigures, []);
  } finally { f.close(); }
});

test('JCB disputed hours include the median per job without percentage prose', () => {
  const f = usualBooks();
  try {
    for (const hours of [60, 70, 80]) f.add({ kind: 'jcb_hours', hours });
    const current = f.add({ kind: 'jcb_hours', hours: 120, accepted: false });
    current.put('DISPUTE', { bill: current.bill, reason: 'मीटर का अंतर अलग है', theirFigure: { hoursTenths: 80 } }, current.buy);
    const facts = differenceFacts(f.ledger, current.orderId, 'J-4');
    const rows = /** @type {any} */ (facts.context).usualFigures;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, '7.0 घंटे');
    assert.equal(rows[0].n, '3');
    assert.match(brief(facts.context, 'seller'), /7.0 घंटे/);
    assert.equal(guardViolation('सामान्य घंटे 7.0 हैं।', facts.allowedNumbers), null);
    assert.equal(guardViolation('घंटे 71% ज़्यादा हैं।', facts.allowedNumbers), 'numbers');
  } finally { f.close(); }
});
