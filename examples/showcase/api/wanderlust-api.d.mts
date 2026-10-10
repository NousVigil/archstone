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
export interface CatalogueStay {
  readonly id: string;
  readonly city: string;
  readonly country: string;
  readonly name: string;
  readonly slug: string;
  readonly pricePerNight: number;
  readonly rating: number;
  readonly petPolicy: string;
  readonly breakfast: boolean;
  readonly family: boolean;
}
/** The one catalogue every endpoint reads. */
export const CATALOGUE: readonly CatalogueStay[];
/** The catalogue city a destination text names (case, diacritics, "City, Country" tolerant), or undefined. */
export function resolveDestination(text: unknown): string | undefined;
/** The recognised preference tags (pets, breakfast, family) in a list; synonyms folded, unknown dropped. */
export function normalizePreferences(list: unknown): string[];
