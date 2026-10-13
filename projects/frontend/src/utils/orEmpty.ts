/**
 * Coalesce a nullable profile field to an empty string for controlled inputs.
 *
 * @param value Field value from the backend.
 * @returns The value, or an empty string when missing.
 */
export function orEmpty(value: string | null | undefined): string {
  return value ?? ''
}
