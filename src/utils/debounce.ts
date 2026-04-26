/**
 * Debounce minimal — no agregamos lodash por una función de 12 líneas.
 *
 * Usado por la view para no spamear `getRelated` cuando el user tipea
 * rápido (modify trigger con default 400ms). El timer se resetea cada
 * call hasta que pasen `ms` sin nuevas invocaciones.
 *
 * `cancel()` permite abortar pending — la view lo llama al unload del
 * panel para no disparar fetches contra el backend después de cerrado.
 */
export interface Debounced<F extends (...args: never[]) => unknown> {
  (...args: Parameters<F>): void;
  cancel(): void;
}

export function debounce<F extends (...args: never[]) => unknown>(
  fn: F,
  ms: number,
): Debounced<F> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = ((...args: Parameters<F>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  }) as Debounced<F>;
  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return wrapped;
}
