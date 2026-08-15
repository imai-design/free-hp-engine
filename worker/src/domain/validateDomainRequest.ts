import { ValidationError } from "./validate.ts";

export const DOMAIN_REQUEST_METHODS = ["self", "wait_crowdfunding", "prepay"] as const;

export type DomainRequestMethod = (typeof DOMAIN_REQUEST_METHODS)[number];

export interface DomainRequestInput {
  storeName: string;
  siteUrl?: string;
  domains: string[];
  contactName: string;
  email: string;
  phone?: string;
  method: DomainRequestMethod;
  note?: string;
  agree: true;
}

const DOMAIN_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.(com|net|jp)$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PHONE_PATTERN = /^[0-9-]+$/u;

function inputRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError("request body must be a JSON object");
  }
  return raw as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string, max: number): string {
  const value = input[key];
  if (typeof value !== "string") throw new ValidationError(`${key} is required`);
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) {
    throw new ValidationError(`${key} must be 1-${max} characters`);
  }
  if (/\p{Cc}/u.test(trimmed)) throw new ValidationError(`${key} contains invalid control characters`);
  return trimmed;
}

function optionalString(input: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ValidationError(`${key} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw new ValidationError(`${key} must be at most ${max} characters`);
  if (/\p{Cc}/u.test(trimmed)) throw new ValidationError(`${key} contains invalid control characters`);
  return trimmed;
}

function optionalNote(input: Record<string, unknown>): string | undefined {
  const value = input.note;
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ValidationError("note must be a string");
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return undefined;
  if (normalized.length > 300) throw new ValidationError("note must be at most 300 characters");
  if (normalized.split("\n").some((line) => /\p{Cc}/u.test(line))) {
    throw new ValidationError("note contains invalid control characters");
  }
  return normalized;
}

function siteUrl(input: Record<string, unknown>): string | undefined {
  const value = optionalString(input, "siteUrl", 200);
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError("siteUrl must be a valid https URL");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || !value.startsWith("https://")) {
    throw new ValidationError("siteUrl must start with https://");
  }
  return value;
}

function requestedDomains(input: Record<string, unknown>): string[] {
  const value = input.domains;
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    throw new ValidationError("domains must contain 1-2 domains");
  }
  return value.map((domain) => {
    if (typeof domain !== "string") throw new ValidationError("each domain must be a string");
    const trimmed = domain.trim();
    const match = DOMAIN_PATTERN.exec(trimmed);
    if (!match || match[1].startsWith("xn--") || trimmed.length > 63 + 1 + match[2].length) {
      throw new ValidationError("domain must use lowercase letters, numbers, hyphens, and .com, .net, or .jp");
    }
    return trimmed;
  });
}

function contactEmail(input: Record<string, unknown>): string {
  const email = requiredString(input, "email", 120);
  if (!EMAIL_PATTERN.test(email)) throw new ValidationError("email is invalid");
  return email;
}

function contactPhone(input: Record<string, unknown>): string | undefined {
  const phone = optionalString(input, "phone", 20);
  if (phone && !PHONE_PATTERN.test(phone)) {
    throw new ValidationError("phone must contain only numbers and hyphens");
  }
  return phone;
}

export function validateDomainRequest(raw: unknown): DomainRequestInput {
  const input = inputRecord(raw);
  const method = input.method;
  if (typeof method !== "string" || !DOMAIN_REQUEST_METHODS.includes(method as DomainRequestMethod)) {
    throw new ValidationError("method is invalid");
  }
  if (input.agree !== true) throw new ValidationError("agree must be true");

  return {
    storeName: requiredString(input, "storeName", 60),
    siteUrl: siteUrl(input),
    domains: requestedDomains(input),
    contactName: requiredString(input, "contactName", 40),
    email: contactEmail(input),
    phone: contactPhone(input),
    method: method as DomainRequestMethod,
    note: optionalNote(input),
    agree: true,
  };
}
