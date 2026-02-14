// Utility to render user-friendly marketplace names (demonym-style)
// Example: 'ATVPDKIKX0DER' -> 'American'

const NAME_MAP: Record<string, string> = {
  // North America
  'ATVPDKIKX0DER': 'American', // US
  'A2EUQ1WTGCTBG2': 'Canadian', // CA
  'A1AM78C64UM0Y8': 'Mexican', // MX
  'A2Q3Y263D00KWC': 'Brazilian', // BR (legacy id in some SDKs)
  // Europe
  'A1F83G8C2ARO7P': 'British', // UK
  'A1PA6795UKMFR9': 'German', // DE
  'A13V1IB3VIYZZH': 'French', // FR
  'A1RKKUPIHCS9HS': 'Spanish', // ES
  'APJ6JRA9NG5V4': 'Italian', // IT
  // Asia-Pacific
  'A1VC38T7YXB528': 'Japanese', // JP
  'A39IBJ37TRP1C6': 'Australian', // AU
  'A19VAU5U5O7RUS': 'Singaporean', // SG
  'A2VIGQ35RCS4UG': 'Emirati', // AE
  'A17E79C6D8DWNP': 'Saudi Arabian', // SA
  'A33AVAJ2PDY3EV': 'Turkish', // TR
  'A21TJRUUN4KGV': 'Indian', // IN
};

export function marketplaceName(id?: string): string {
  if (!id) return '';
  return NAME_MAP[id] || id;
}

