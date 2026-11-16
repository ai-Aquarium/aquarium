/**
 * Stops the page behind a modal layer from scrolling. Locks nest (a maximized
 * panel inside a Sheet, a dialog over either): the body's own overflow comes
 * back only when the last lock is released, whatever order layers unmount in.
 */
let count = 0;
let saved = "";

export function lockBodyScroll(): () => void {
  if (count++ === 0) {
    saved = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--count === 0) document.body.style.overflow = saved;
  };
}
