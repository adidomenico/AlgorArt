/**
 * Shorten an address to `width` characters at each end, separated by `...`.
 *
 * @param address Address to shorten, or null.
 * @param width Number of characters to keep at each end.
 * @returns Ellipsised address.
 */
export function ellipseAddress(address: string | null, width = 6): string {
  return address ? `${address.slice(0, width)}...${address.slice(-width)}` : (address ?? '')
}
