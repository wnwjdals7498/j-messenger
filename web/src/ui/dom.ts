export interface ElProps {
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document, tag: K, props?: ElProps, children?: Node[],
): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (props?.className) element.className = props.className;
  if (props?.text) element.textContent = props.text;
  if (props?.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) {
      element.setAttribute(key, value);
    }
  }
  if (children) {
    for (const child of children) {
      element.appendChild(child);
    }
  }
  return element;
}

export function clear(node: Element): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}
