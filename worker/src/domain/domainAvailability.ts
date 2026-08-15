export type AvailabilityStatus = "available" | "taken" | "unknown";
export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export const RDAP_TIMEOUT_MS = 4_000;

function rdapUrl(domain: string): string | null {
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (tld === "com" || tld === "net") {
    return `https://rdap.verisign.com/${tld}/v1/domain/${domain}`;
  }
  if (tld === "jp") return `https://rdap.jprs.jp/domain/${domain}`;
  return null;
}

export async function checkDomainAvailability(
  domain: string,
  fetchImpl: FetchImpl = fetch,
): Promise<AvailabilityStatus> {
  const url = rdapUrl(domain);
  if (!url) return "unknown";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RDAP_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (response.status === 404) return "available";
    if (response.status === 200) return "taken";
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timeout);
  }
}
