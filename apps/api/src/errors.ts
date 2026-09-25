/**
 * Errors carrying an HTTP status. Fastify's default error handler reads
 * `statusCode` off a thrown error, so a route or hook can throw one of these
 * and the client receives the right status with the message unchanged.
 *
 * Messages say what is missing or wrong and what to do about it. They never
 * echo a token, a signature or a secret back to the caller.
 */
export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

/** 401. The caller did not prove who it is. */
export class UnauthorisedError extends HttpError {
  constructor(message: string) {
    super(401, message);
    this.name = 'UnauthorisedError';
  }
}

/** 400. The caller proved who it is and sent something the route cannot use. */
export class BadRequestError extends HttpError {
  constructor(message: string) {
    super(400, message);
    this.name = 'BadRequestError';
  }
}

/** 403. The caller proved who they are and may not do this. */
export class ForbiddenError extends HttpError {
  constructor(message: string) {
    super(403, message);
    this.name = 'ForbiddenError';
  }
}
