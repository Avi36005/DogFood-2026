/** An error that maps to an HTTP status. Domain code throws these; the server turns them into responses. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A form or JSON body failed validation. Carries a message per field so the form can be re-rendered. */
export class ValidationError extends HttpError {
  readonly fields: Record<string, string>;

  constructor(fields: Record<string, string>, message = 'Please correct the highlighted fields.') {
    super(422, message);
    this.fields = fields;
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const unauthorized = (message = 'Sign in to continue.') => new HttpError(401, message);
export const forbidden = (message = 'You do not have access to this.') => new HttpError(403, message);
export const notFound = (message = 'Not found.') => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
