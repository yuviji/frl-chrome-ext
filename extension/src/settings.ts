export type Settings = {
  allowlistEnabled: boolean;
  allowedDomains: string[];
};

export async function getSettings(): Promise<Settings> {
  try {
    const res = await chrome.storage.sync.get({ allowlistEnabled: false, allowedDomains: [] as string[] });
    const enabled = Boolean(res?.allowlistEnabled);
    const list = Array.isArray(res?.allowedDomains) ? (res.allowedDomains as string[]) : [];
    return { allowlistEnabled: enabled, allowedDomains: normalizeDomains(list) };
  } catch {
    return { allowlistEnabled: false, allowedDomains: [] };
  }
}

export function isDomainAllowed(hostname: string, allowed: string[]): boolean {
  const host = normalizeDomain(hostname);
  const list = normalizeDomains(allowed);
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}

function normalizeDomains(domains: string[]): string[] {
  return domains
    .map((d) => normalizeDomain(d))
    .filter((d, i, arr) => !!d && arr.indexOf(d) === i);
}

function normalizeDomain(domain: string): string {
  let d = (domain || "").trim().toLowerCase();
  if (!d) return "";
  try {
    if (/^https?:\/\//i.test(d)) d = new URL(d).hostname;
  } catch {}
  // drop wildcard or leading dot
  d = d.replace(/^\*?\.?/, "");
  // strip trailing dot
  d = d.replace(/\.$/, "");
  return d;
}

export {}


