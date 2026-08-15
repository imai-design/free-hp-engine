export const DOMAIN_PRICES_YEN = {
  com: 1_800,
  net: 1_800,
  jp: 3_300,
} as const;

export function quoteDomains(domains: readonly string[]): Record<string, number> {
  return Object.fromEntries(domains.map((domain) => {
    const tld = domain.slice(domain.lastIndexOf(".") + 1) as keyof typeof DOMAIN_PRICES_YEN;
    return [domain, DOMAIN_PRICES_YEN[tld]];
  }));
}
