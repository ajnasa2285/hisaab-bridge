import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rupees, hours, qty, day, groupIndian, orNone, NONE } from '../../src/i18n/format.js';

test('money in paise with Indian grouping', () => {
  assert.equal(rupees(732000), '₹7,320');
  assert.equal(rupees(732050), '₹7,320.50');
  assert.equal(rupees(5), '₹0.05');
  assert.equal(rupees(0), '₹0');
  assert.equal(rupees(123456789), '₹12,34,567.89');
  assert.equal(rupees(-50000), '-₹500');
  assert.equal(groupIndian(100000), '1,00,000');
  assert.throws(() => rupees(/** @type {any} */ (73.2)), /safe integer/);
});

test('hours in tenths, quantities in hundredths', () => {
  assert.equal(hours(61), '6.1 घंटे');
  assert.equal(hours(60), '6 घंटे');
  assert.equal(hours(0), '0 घंटे');
  assert.equal(qty(5000, 'बोरी'), '50 बोरी');
  assert.equal(qty(250, 'ट्रॉली'), '2.5 ट्रॉली');
  assert.equal(qty(125, 'टन'), '1.25 टन');
  assert.equal(qty(105, 'टन'), '1.05 टन');
  assert.throws(() => hours(/** @type {any} */ ('61')), /safe integer/);
});

test('days in Hindi with digits; a missing value is a dash', () => {
  assert.equal(day('2026-10-29'), '29 अक्टूबर 2026');
  assert.equal(day('2026-01-05'), '5 जनवरी 2026');
  assert.throws(() => day('29-10-2026'), /YYYY-MM-DD/);
  assert.equal(orNone(null, rupees), NONE);
  assert.equal(orNone(732000, rupees), '₹7,320');
});
