// The one error type core code throws to say "answer the caller with this HTTP status". Owns nothing else.
export class HttpError extends Error {
  constructor(status, message, type = "elyra_error") { super(message); this.status = status; this.type = type; }
}
