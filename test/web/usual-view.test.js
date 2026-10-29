import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usualPanels, usualValue } from '../../web/usual-view.js';
import { traceRow } from '../../web/trace-view.js';
import { TEXTS } from '../../web/texts.js';
import { usualHistory } from '../trace/usual-fixture.js';

test('usual cards use pre-tax rates, quantity and GST, grouped by each local counterparty', () => {
  const events = [...usualHistory(), ...usualHistory(3, 'agent:supplier-2').map((e) => ({ ...e, seq: e.seq + 15 }))];
  const panels = usualPanels(events, TEXTS.hi);
  assert.deepEqual(panels.map((p) => p.counterparty), ['agent:supplier-1', 'agent:supplier-2']);
  assert.deepEqual(panels[0].rows.map((r) => [r.metric, r.median, r.n]), [
    [TEXTS.hi.usual_metrics.rate, '₹380/बोरी', 3], [TEXTS.hi.usual_metrics.quantity, '50 बोरी', 3], [TEXTS.hi.usual_metrics.gst, '28%', 3],
  ]);
  assert.ok(panels[0].rows.every((r) => r.min === r.max && r.last === r.median));
  assert.doesNotMatch(JSON.stringify(panels), /—|24320/);
  assert.deepEqual(usualPanels(usualHistory(2), TEXTS.en), []);
});

test('a seller uses its own direction and never gets another seller in its history', () => {
  const own = usualHistory().map((e) => ({ ...e, direction: /** @type {'in'|'out'} */ (e.direction === 'in' ? 'out' : 'in') }));
  const panels = usualPanels(own, TEXTS.en);
  assert.deepEqual(panels.map((p) => p.counterparty), ['agent:contractor-1']);
});

test('usual format preserves fractions and trace uses a flag, without a failure verdict', () => {
  assert.equal(usualValue({ metric: 'hours', unit: 'घंटे' }, 65, TEXTS.en), '6.5 Hours');
  assert.equal(usualValue({ metric: 'quantity', unit: 'टन' }, 125, TEXTS.hi), '1.25 टन');
  const row = traceRow({ id: 1, at: '', agent: 'site', orderId: 'o', ref: 'P-1', convo: null, kind: 'check',
    title: 'rate vs usual: ₹500 vs median ₹380 over 3 orders → 32% (unusual, flagged)', detail: { name: 'usual', pass: false, unusual: true }, ms: null }, TEXTS.en);
  assert.equal(row.mark, 'flagged');
  assert.equal(row.icon, '⚑');
  assert.doesNotMatch(row.cls, /bad/);
  assert.match(row.text, /32%/);
});
