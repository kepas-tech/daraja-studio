import type { ErrorRequestHandler, RequestHandler } from 'express';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public details?: unknown) {
    super(message ?? code);
  }
}

export const notFound: RequestHandler = (_req, _res, next) => next(new HttpError(404, 'not_found'));

export const errorMiddleware: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  // body-parser echoes fragments of the offending payload into its own error message for these
  // two types — never let that reach the logs.
  const type = (err as { type?: unknown } | null)?.type;
  if (type === 'entity.parse.failed' || type === 'entity.too.large') {
    console.error('unhandled', 'body parse failed');
  } else {
    console.error('unhandled', err instanceof Error ? err.message : err);
  }
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on our side.' } });
};
