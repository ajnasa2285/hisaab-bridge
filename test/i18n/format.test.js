import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hours, qty, rupees } from '../../src/i18n/format.js';

test('money, hours and quantities are formatted by code', () => {
  assert.equal(rupees(732000), '₹7,320');
  assert.equal(rupees(12345678950), '₹12,34,56,789.50');
  assert.equal(rupees(5), '₹0.05');
  assert.equal(rupees(0), '₹0');
  assert.equal(hours(61), '6.1');
  assert.equal(hours(12406), '1240.6');
  assert.equal(hours(0), '0.0');
  assert.equal(qty(5000), '50');
  assert.equal(qty(1250), '12.5');
  assert.equal(qty(1205), '12.05');
  assert.throws(() => rupees(1.5));
});
