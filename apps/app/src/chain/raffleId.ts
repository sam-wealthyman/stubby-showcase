/**
 * Reading a raffle id out of a URL.
 *
 * `/raffle/<anything>` is a URL anyone can type, and neither obvious conversion
 * is safe: `BigInt('abc')` throws, and `Number('abc')` is NaN. Either would
 * take the screen down instead of saying the draw is not valid.
 *
 * Its own module rather than living in the screen, so it can be tested without
 * pulling React Native's Flow-typed source into the test run.
 */

/** Returns undefined for anything that is not a raffle id. */
export function parseId(raw: string | undefined): bigint | undefined {
  // Deliberately strict: no sign, no decimal point, no whitespace, no hex, and
  // no non-ASCII digits — `Number('١٢٣')` is 123, which is not a thing a route
  // should quietly accept.
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const id = BigInt(raw);
  // Ids start at 1. Zero is the contract's `Status.None`.
  return id > 0n ? id : undefined;
}
