// Types for the plain-JavaScript handler, so TypeScript tests can import it without allowJs.
export interface HandleOptions {
  /** Epoch milliseconds, or a function returning them. Defaults to the wall clock. */
  now?: number | (() => number);
  /** Origin used in image URLs. Defaults to IMAGE_BASE. */
  imageBase?: string;
}
export const IMAGE_BASE: string;
export const PAGES_BASE: string;
export const UNDECLARED_IMAGE_HOST: string;
export const UNDECLARED_PAGE_HOST: string;
export const UNDECLARED_MARKUP_HOST: string;
export const QUOTE_WINDOW_MS: number;
export const BOOKING_ID_RE: RegExp;
export function handle(request: Request, options?: HandleOptions): Promise<Response>;
export const GUEST_NAMES: readonly string[];
