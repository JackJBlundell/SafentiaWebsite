// ============================================================================
// Password policy + strength estimate for self-serve sign-up.
//
// Platform-free and dependency-free on purpose: it runs on every keystroke, it
// must pre-render (no window access) and it adds nothing to the bundle beyond
// this file. The POLICY (`passwordProblems`) is the hard gate the form refuses
// to submit past; the SCORE is guidance for the meter. Firebase Auth remains
// the server-side boundary - enable its password policy in the console so a
// client bypassing this form meets the same minimum (see SIGNUP notes in
// DEPLOY_PLAN.md).
// ============================================================================

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** A short list of the passwords and stems that top every breach corpus. Not a
 *  breach check - it catches the obvious picks without shipping a dictionary. */
const COMMON = [
  'password',
  'passw0rd',
  'qwerty',
  'letmein',
  'welcome',
  'iloveyou',
  'admin',
  'abc123',
  '123456',
  '111111',
  'monkey',
  'dragon',
  'football',
  'sunshine',
  'princess',
  'safentia',
  'firerisk',
  'firerite',
];

export interface PasswordContext {
  email?: string;
  name?: string;
}

/** Every policy rule the password breaks, as user-facing British-English copy.
 *  Empty means acceptable. */
export function passwordProblems(
  password: string,
  context: PasswordContext = {},
): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push(`Use no more than ${PASSWORD_MAX_LENGTH} characters.`);
  }
  if (!/[A-Za-z]/.test(password) || !/[^A-Za-z]/.test(password)) {
    problems.push('Mix letters with numbers or symbols.');
  }
  const lower = password.toLowerCase();
  if (COMMON.some((word) => lower.includes(word))) {
    problems.push('Avoid common words such as "password" or "qwerty".');
  }
  for (const piece of personalPieces(context)) {
    if (lower.includes(piece)) {
      problems.push('Do not include your name or email address.');
      break;
    }
  }
  return problems;
}

export type StrengthLevel = 0 | 1 | 2 | 3 | 4;

export const STRENGTH_LABELS: Record<StrengthLevel, string> = {
  0: 'Too weak',
  1: 'Weak',
  2: 'Fair',
  3: 'Strong',
  4: 'Very strong',
};

/** A 0-4 estimate from length and character variety, capped at 1 while any
 *  policy rule is broken so the meter never praises a password the form will
 *  refuse. */
export function passwordStrength(
  password: string,
  context: PasswordContext = {},
): StrengthLevel {
  if (!password) {
    return 0;
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(password),
  ).length;
  // Long runs of one character ("aaaaaaaaaa1") add length but no entropy.
  const distinct = new Set(password).size;

  let score = 0;
  if (password.length >= PASSWORD_MIN_LENGTH) score += 1;
  if (password.length >= 14) score += 1;
  if (password.length >= 18) score += 1;
  if (classes >= 3) score += 1;
  if (classes === 4) score += 1;
  if (distinct < 6) score -= 2;

  const capped = passwordProblems(password, context).length > 0
    ? Math.min(score, 1)
    : Math.max(score, 2);
  return Math.max(0, Math.min(4, capped)) as StrengthLevel;
}

function personalPieces({ email, name }: PasswordContext): string[] {
  const pieces: string[] = [];
  const local = email?.split('@')[0]?.toLowerCase().trim();
  if (local && local.length >= 3) {
    pieces.push(local);
  }
  for (const part of (name ?? '').toLowerCase().split(/\s+/)) {
    if (part.length >= 3) {
      pieces.push(part);
    }
  }
  return pieces;
}
