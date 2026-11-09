/**
 * crypto.randomUUID only exists in secure contexts; plain-http LAN testing on a
 * phone is not one, but getRandomValues is available everywhere.
 */
export function newId(): string {
  if (typeof crypto.randomUUID === "function" && window.isSecureContext) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
