import { ConvexError } from "convex/values";

/**
 * The sign-up password policy, shared by the server (convex/auth.ts wires it
 * into the Password provider's validatePasswordRequirements, which Convex
 * Auth runs on the signUp and reset flows ONLY — existing passwords keep
 * signing in) and the client (Auth.tsx renders the live checklist from the
 * same rules, so the UI can never drift from what the server enforces).
 */

export const MIN_PASSWORD_LENGTH = 12;

export interface PasswordRule {
  id: string;
  label: string;
  test: (password: string) => boolean;
}

export const PASSWORD_RULES: PasswordRule[] = [
  {
    id: "length",
    label: `At least ${MIN_PASSWORD_LENGTH} characters`,
    test: (p) => p.length >= MIN_PASSWORD_LENGTH,
  },
  { id: "lower", label: "A lowercase letter", test: (p) => /[a-z]/.test(p) },
  { id: "upper", label: "An uppercase letter", test: (p) => /[A-Z]/.test(p) },
  { id: "digit", label: "A number", test: (p) => /[0-9]/.test(p) },
  {
    id: "symbol",
    label: "A symbol (e.g. ! ? # …)",
    test: (p) => /[^A-Za-z0-9]/.test(p),
  },
];

export function unmetPasswordRules(password: string): PasswordRule[] {
  return PASSWORD_RULES.filter((r) => !r.test(password));
}

/** Server-side gate. Throws a ConvexError the login screen shows verbatim. */
export function assertPasswordPolicy(password: string): void {
  const unmet = unmetPasswordRules(password);
  if (unmet.length > 0) {
    throw new ConvexError(
      "Password too weak — still needed: " +
        unmet.map((r) => r.label.toLowerCase()).join(", ") +
        ".",
    );
  }
}
