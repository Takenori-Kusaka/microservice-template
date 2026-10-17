/** Raised when a request cannot be attributed to a verified tenant (guideline §13 セキュリティ). */
export class TenantContextError extends Error {
  readonly code = 'TENANT_CONTEXT_MISSING';
  readonly httpStatus = 403;
  readonly retryable = false;
  constructor(message = 'request is not bound to a verified tenant') {
    super(message);
    this.name = 'TenantContextError';
  }
}

/** Raised when an inbound value violates the identifier contract. */
export class InvalidIdentifierError extends Error {
  readonly code = 'INVALID_IDENTIFIER';
  readonly httpStatus = 400;
  readonly retryable = false;
  constructor(readonly field: string) {
    super(`invalid identifier: ${field}`);
    this.name = 'InvalidIdentifierError';
  }
}
