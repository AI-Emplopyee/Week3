/** Small, deliberately incomplete official UN/LOCODE catalog. These are factual
 * locations, not declarations that a particular ECUS installation accepts them.
 * Sources, verification date and scope: docs/verified-form-normalization-sources.json. */
export type VerifiedTransportLocation = {
  code: string;
  name: string;
  countryCode: string;
  aliases: readonly string[];
  source: string;
  reason: string;
  matchKind: 'location-code' | 'unlocode' | 'route-prefix' | 'published-name';
};

const locations = [
  { code: 'BEBRU', name: 'Brussel (Bruxelles)', countryCode: 'BE',
    aliases: ['Brussel (Bruxelles)', 'Brussel', 'Bruxelles'],
    source: 'https://service.unece.org/trade/locode/be.htm' },
  { code: 'VNSGN', name: 'Ho Chi Minh City', countryCode: 'VN',
    aliases: ['Ho Chi Minh City'],
    source: 'https://service.unece.org/trade/locode/vn.htm' },
] as const;

/** Exact known codes/names only. Caller must establish that the value comes from
 * the relevant current transport field. A routing suffix is ignored only after
 * an explicit matching country + location token; no prose or route is searched. */
export function verifiedTransportLocation(value: string): VerifiedTransportLocation | undefined {
  const literal = value.trim().replace(/\s+/g, ' ').toUpperCase();
  for (const location of locations) {
    let matchKind: VerifiedTransportLocation['matchKind'] | undefined;
    if (literal === location.code.slice(2)) matchKind = 'location-code';
    else if ([location.code, `${location.countryCode} ${location.code.slice(2)}`, `${location.countryCode}-${location.code.slice(2)}`].includes(literal)) matchKind = 'unlocode';
    else if (new RegExp(`^${location.countryCode}-${location.code.slice(2)}-[A-Z0-9]{1,12}$`).test(literal)) matchKind = 'route-prefix';
    else if (location.aliases.some(alias => alias.toUpperCase() === literal)) matchKind = 'published-name';
    if (matchKind) return {
      ...location, matchKind,
      reason: `transport-location: Explicit ${matchKind} represented by published UN/LOCODE ${location.code} (${location.name}); ${location.source}. Original source value retained.`,
    };
  }
  return undefined;
}
