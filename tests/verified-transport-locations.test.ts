import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedTransportLocation } from '../lib/verified-transport-locations.ts';

test('published transport locations normalize only exact known location codes', () => {
  for (const value of ['BRU', 'bebru', 'BE BRU', 'BE-BRU']) {
    const result = verifiedTransportLocation(value);
    assert.equal(result?.code, 'BEBRU');
    assert.equal(result?.name, 'Brussel (Bruxelles)');
    assert.equal(result?.countryCode, 'BE');
    assert.match(result?.source ?? '', /unece\.org/);
    assert.match(result?.reason ?? '', /Original source value retained/);
  }
  for (const value of ['SGN', 'VNSGN', 'vn sgn', 'VN-SGN']) {
    assert.equal(verifiedTransportLocation(value)?.code, 'VNSGN');
    assert.equal(verifiedTransportLocation(value)?.name, 'Ho Chi Minh City');
  }
});

test('routing suffix cannot change an explicitly matching country and location', () => {
  assert.equal(verifiedTransportLocation('VN-SGN-SSS')?.matchKind, 'route-prefix');
  assert.equal(verifiedTransportLocation('VN-SGN-SSS')?.code, 'VNSGN');
  assert.equal(verifiedTransportLocation('BE-BRU-001')?.code, 'BEBRU');
  for (const value of ['BE-SGN-SSS', 'VN-BRU-SSS', 'XX-SGN-SSS', 'VN-XXX-SSS', 'SGN-SSS', 'VN-SGN-SSS-BRU', 'VN-SGN-']) {
    assert.equal(verifiedTransportLocation(value), undefined, value);
  }
});

test('lookup accepts published names but never guesses from routes, prose or unknown locations', () => {
  assert.equal(verifiedTransportLocation(' ho chi minh city ')?.code, 'VNSGN');
  assert.equal(verifiedTransportLocation('Bruxelles')?.code, 'BEBRU');
  for (const value of ['Any port in Vietnam', 'Any port in Belgium', 'SGN / BRU', 'BRU to SGN', 'Airport SGN', 'VN SGN suffix', 'Ho Chi Minh City, VN', 'HAN', 'ZZZZZ', '']) {
    assert.equal(verifiedTransportLocation(value), undefined, value);
  }
});
