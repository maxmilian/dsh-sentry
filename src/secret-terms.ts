/**
 * Shared credential/PII naming detection.
 *
 * Both the tag filter (`trim-event.ts`) and the HTTP 400 detail sanitizer (`errors.ts`)
 * have to recognize the same credential names, so the patterns live here rather than
 * being duplicated and drifting apart. Every check runs against a normalized form so a
 * name is caught no matter which separator convention produced it: `apiKey`, `api_key`,
 * `api-key`, `api.key`, and `api key` all normalize to `api key`.
 */

/** Folds camelCase boundaries and `. _ - whitespace` separators into single spaces, lowercased. */
export function normalizeSecretText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[\s._-]+/g, ' ')
    .toLowerCase()
    .trim()
}

/**
 * Credential names. Matched against normalized text, so a single space stands for any
 * of the separator conventions above. The space inside the compound group is optional
 * because normalization cannot split a run-together or all-caps spelling: `apikey` and
 * `APIKEY` both normalize to themselves, not to `api key`.
 */
const CREDENTIAL_PATTERN =
  /(bearer|authorization|sntry[us]|secret|pass(?:word|wd|phrase)|pwd|credential|token ?[:=]|(?:api|private|public|access|ssh|signing|encryption|client|auth|secret|session|refresh) ?(?:key|token|secret)|connection string|database url|webhook url|credit ?card|\bssn\b|social security|\bjwt\b|\bdsn\b|signature)/

/** Names that carry personal data rather than credentials. Tag keys only. */
const PII_PATTERN = /(cookie|session|auth|token|user ?name|e ?mail|\bip(?: address)?\b)/

/** True when a free-text string names a credential. Used to suppress upstream error details. */
export function containsCredentialTerm(value: string): boolean {
  return CREDENTIAL_PATTERN.test(normalizeSecretText(value))
}

/** True when a tag key names a credential or personal data and must not be echoed back. */
export function isSecretName(key: string): boolean {
  const normalized = normalizeSecretText(key)
  return CREDENTIAL_PATTERN.test(normalized) || PII_PATTERN.test(normalized)
}
