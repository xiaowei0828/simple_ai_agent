export class PreviousResponseUnavailableError extends Error {
  readonly responseId: string;

  constructor(responseId: string, cause?: unknown) {
    super(`The previous response '${responseId}' is no longer available.`, { cause });
    this.name = "PreviousResponseUnavailableError";
    this.responseId = responseId;
  }
}
