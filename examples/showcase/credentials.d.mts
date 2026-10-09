export interface DemoCaller {
  accessToken?: string;
  principal?: string;
}
export const DEMO_KEY_A: string;
export const DEMO_KEY_B: string;
export const DEMO_KEYS: Readonly<{
  A: Readonly<{ key: string; principal: string }>;
  B: Readonly<{ key: string; principal: string }>;
}>;
export const ACCEPTED_KEYS: readonly string[];
export function callerFor(label: "none" | "A" | "B"): DemoCaller | undefined;
