import assert from 'node:assert/strict';
import test from 'node:test';
import { explicitFormCode } from '../lib/explicit-form-code.ts';

test('explicit physical units use the narrowly supported VNACCS representations', () => {
  for (const field of ['unit', 'unit2']) {
    for (const value of ['PC', 'PCS', 'piece', 'pieces', 'PCE', ' pcs ']) assert.equal(explicitFormCode(field, value)?.value, 'PCE');
    for (const value of ['kg', 'KG', 'kilogram', 'kilograms', 'KGM']) assert.equal(explicitFormCode(field, value)?.value, 'KGM');
  }
  assert.equal(explicitFormCode('grossWeightUnit', 'KG')?.value, 'KGM');
});

test('unit mappings never invent packages, sets, missing units or a new physical dimension', () => {
  for (const value of ['PK', 'SET', 'AU', 'KGS', '', '10 KG', 'PC / SET', 'KG/HR']) assert.equal(explicitFormCode('unit', value), undefined, value);
  for (const field of ['packageUnit', 'quantity', 'quantity2', 'description', 'remarks']) {
    for (const value of ['KG', 'PCS']) assert.equal(explicitFormCode(field, value), undefined, `${field}: ${value}`);
  }
  assert.equal(explicitFormCode('grossWeightUnit', 'PCS'), undefined);
});

test('explicit package wording maps to PK without inferring packaging from piece counts', () => {
  for (const value of ['Package', 'PACKAGES', 'PKG', 'pkgs', 'PK', ' packages ']) {
    assert.equal(explicitFormCode('packageUnit', value)?.value, 'PK');
    assert.equal(explicitFormCode('packageUnit', value)?.source, 'unece-rec21-package');
  }
  for (const value of ['Piece', 'Pieces', 'PCS', 'PCE', 'PP', 'Carton', '1 package', 'package / piece', '']) {
    assert.equal(explicitFormCode('packageUnit', value), undefined, value);
  }
  assert.equal(explicitFormCode('unit', 'packages'), undefined);
  assert.equal(explicitFormCode('unit', 'Piece')?.value, 'PCE');
});

test('historical payment normalization requires explicit codebook selection and an exact payment field', () => {
  for (const value of ['TT', 'TTr', 'TTR', 'Telegraphic Transfer']) {
    assert.equal(explicitFormCode('paymentMethod', value), undefined, 'Current forms must not silently select a historical codebook');
    assert.equal(explicitFormCode('paymentMethod', value, 'vnaccs-circular-38-2015')?.value, 'TTR');
    assert.equal(explicitFormCode('remarks', value, 'vnaccs-circular-38-2015'), undefined);
  }
  for (const value of ['30 days', 'TT in 30 days', 'T/T', 'Bank transfer', 'Telegraphic Transfer or LC', '']) {
    assert.equal(explicitFormCode('paymentMethod', value, 'vnaccs-circular-38-2015'), undefined, value);
  }
});
