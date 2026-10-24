export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'ERROR',
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
