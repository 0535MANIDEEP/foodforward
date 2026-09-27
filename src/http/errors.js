/**
 * API errors.
 *
 * RFC 7807 problem details, because a client has to decide between "show the
 * supplier a retry button" and "tell them the food cannot be sent", and a prose
 * string makes that guesswork.
 */

export function apiError(status, detail, type, extra = {}) {
  return { type: `urn:foodforward:${type}`, title: titleFor(status), status, detail, ...extra };
}

function titleFor(status) {
  switch (status) {
    case 400: return 'Invalid request';
    case 404: return 'Not found';
    case 409: return 'Conflict';
    case 500: return 'Something went wrong';
    default: return 'Request failed';
  }
}

export const badRequest = (detail, extra) => apiError(400, detail, 'invalid', extra);
export const notFound = (detail) => apiError(404, detail, 'not_found');
export const conflict = (detail, extra) => apiError(409, detail, 'conflict', extra);

/**
 * Turn anything thrown into a response.
 *
 * The rule that matters: a 500 never carries an internal message. A MySQL error
 * in a response body names the constraint, the table and the driver version,
 * which is a free map of the schema, and there is nothing a user gains from it.
 */
export function errorHandler(logger = console) {
  // eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity.
  return (err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json(badRequest('The request body was not valid JSON.'));
      return;
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json(badRequest('That request body is too large.'));
      return;
    }
    if (err?.status && err?.type) {
      res.status(err.status).json(err);
      return;
    }

    logger.error?.('[unhandled]', err?.stack ?? String(err), { path: req?.originalUrl, method: req?.method });
    res.status(500).json(apiError(500, 'The request could not be completed.', 'internal'));
  };
}
