/** Read a required env var or fail loudly. Never logs the value. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** Validate a whole set up front, so a task fails at the top instead of halfway through. */
export function requireEnvs(names: string[]): void {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);
}

export const AGENT_ENV = [
  "OPENAI_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  ...GOOGLE_ENV_NAMES(),
];

export function GOOGLE_ENV_NAMES() {
  return ["GOOGLE_SERVICE_ACCOUNT_EMAIL", "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", "GOOGLE_CALENDAR_ID", "MEET_LINK"];
}

export const WHATSAPP_ENV = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"];

export const businessTz = () => process.env.BUSINESS_TIMEZONE || "America/New_York";
export const businessName = () => process.env.BUSINESS_NAME || "Northbeam Advisory";
