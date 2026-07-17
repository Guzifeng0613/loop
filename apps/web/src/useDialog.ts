import { useEffect, useRef } from 'react';

const focusableSelector = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

const dialogStack: HTMLElement[] = [];
const inertState = new WeakMap<HTMLElement, { count: number; initiallyInert: boolean }>();

function outsideDialogPath(dialog: HTMLElement): HTMLElement[] {
  const outside = new Set<HTMLElement>();
  let node: HTMLElement | null = dialog;
  while (node?.parentElement) {
    const parent: HTMLElement = node.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling !== node && sibling instanceof HTMLElement) outside.add(sibling);
    }
    if (parent.classList.contains('app-shell')) break;
    node = parent;
  }
  return [...outside];
}

function acquireInert(element: HTMLElement): void {
  const state = inertState.get(element);
  if (state) {
    state.count += 1;
    element.inert = true;
    return;
  }
  inertState.set(element, { count: 1, initiallyInert: element.inert });
  element.inert = true;
}

function releaseInert(element: HTMLElement): void {
  const state = inertState.get(element);
  if (!state) return;
  state.count -= 1;
  if (state.count > 0) return;
  element.inert = state.initiallyInert;
  inertState.delete(element);
}

export function useDialog<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  const restoreFocusRef = useRef<HTMLElement | undefined>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined
  );
  onCloseRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const outside = outsideDialogPath(dialog);
    dialogStack.push(dialog);
    for (const element of outside) acquireInert(element);

    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
    (dialog.querySelector<HTMLElement>('[autofocus], [data-dialog-initial-focus]') ?? focusable()[0] ?? dialog).focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (dialogStack.at(-1) !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const index = dialogStack.lastIndexOf(dialog);
      if (index >= 0) dialogStack.splice(index, 1);
      for (const element of outside) releaseInert(element);
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
    };
  }, []);
  return ref;
}
