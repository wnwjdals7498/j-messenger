// Test helper. Creates an isolated happy-dom document for one test.
import { Window } from 'happy-dom';

export function createDom() {
  const window = new Window({ url: 'http://localhost:5173/' });
  const document = window.document as unknown as Document;
  const root = document.createElement('div');
  root.id = 'app';
  document.body.appendChild(root);
  return { window, document, root };
}

/** Wait one macrotask so pending promises and setTimeout(0) callbacks run. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wait several macrotasks; use after actions that chain awaits. */
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

/** Dispatch a bubbling, cancelable keydown on target and return the event. */
export function keydown(window: Window, target: EventTarget, init: Record<string, unknown> = {}) {
  const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event as unknown as Event);
  return event;
}
