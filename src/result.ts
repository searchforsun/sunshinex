export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}
