import type { RateLimitStore } from "./rateLimit.ts";

function randomPart(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 10);
}

function safeName(storeName: string): string {
  const ascii = storeName.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28);
  return ascii || "site";
}

export async function createUniqueSlug(store: RateLimitStore, storeName: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = `${safeName(storeName)}-${randomPart()}`;
    if (!(await store.get(`site:${slug}`))) return slug;
  }
  throw new Error("could not allocate a unique slug");
}
