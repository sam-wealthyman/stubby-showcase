/**
 * The new-draw composer's arithmetic.
 *
 * Section 14 step 6 asks for a "prize / entry price / ROI calculator", and the
 * solver already exists in `@stubby/shared` — `solveRaffle` takes exactly three
 * of the four numbers and derives the fourth, with Section 11.6's rounding rule
 * and the bounds checks. This adds only the part a screen needs: turning what
 * the owner has typed into a request the solver will accept, and saying plainly
 * when it will not.
 *
 * Pure. Separate from the screen because "which three fields are filled in" is
 * fiddly, and getting it wrong means a calculator that quietly solves for the
 * wrong thing.
 */

import { UsdcParseError, parseUsdc, solveRaffle, type SolveResult } from '@stubby/shared';

/** What the owner has typed. All strings, because inputs are. */
export interface ComposerFields {
  prize: string;
  entryPrice: string;
  totalEntries: string;
  targetRoi: string;
}

export type ComposerState =
  /** Fewer than three fields filled: nothing to solve yet. */
  | { kind: 'incomplete'; filled: number; needed: number }
  /** More than three: the solver would not know which to derive. */
  | { kind: 'over-specified'; filled: number }
  /** A field is not a number the contract could use. */
  | { kind: 'unparseable'; field: keyof ComposerFields; detail: string }
  | { kind: 'solved'; result: SolveResult };

/**
 * Which of the four fields carry a usable value.
 *
 * Whitespace is not a value. An owner who typed a space into a field they meant
 * to leave blank would otherwise get "over-specified" and no explanation.
 */
function filledKeys(fields: ComposerFields): (keyof ComposerFields)[] {
  return (Object.keys(fields) as (keyof ComposerFields)[]).filter(
    (key) => fields[key].trim() !== '',
  );
}

export function composeRaffle(fields: ComposerFields): ComposerState {
  const filled = filledKeys(fields);

  if (filled.length < 3) return { kind: 'incomplete', filled: filled.length, needed: 3 };
  if (filled.length > 3) return { kind: 'over-specified', filled: filled.length };

  const request: Parameters<typeof solveRaffle>[0] = {};

  for (const key of filled) {
    const raw = fields[key].trim();
    try {
      if (key === 'totalEntries') {
        // Entries are a count, not money. `parseUsdc` would happily read "70.5"
        // as 70.5 tickets, which the contract cannot represent.
        if (!/^\d+$/.test(raw)) {
          return { kind: 'unparseable', field: key, detail: 'a whole number of tickets' };
        }
        request.totalEntries = Number(raw);
      } else if (key === 'targetRoi') {
        request.targetRoi = parseUsdc(raw);
      } else {
        request[key] = parseUsdc(raw);
      }
    } catch (error) {
      return {
        kind: 'unparseable',
        field: key,
        detail:
          error instanceof UsdcParseError ? error.message : 'a plain amount, e.g. 50 or 12.50',
      };
    }
  }

  try {
    return { kind: 'solved', result: solveRaffle(request) };
  } catch (error) {
    // solveRaffle throws only on the wrong arity, which `filled.length` has
    // already ruled out — but a throw here must not take the screen down.
    return {
      kind: 'unparseable',
      field: 'prize',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Seconds for the contract, from a number of days the owner picked. */
export function windowSeconds(days: number): bigint {
  return BigInt(Math.round(days * 24 * 60 * 60));
}

/** The default window, matching Section 2's seven days. */
export const DEFAULT_WINDOW_DAYS = 7;
