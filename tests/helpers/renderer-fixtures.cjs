const { Children, isValidElement } = require('react');

function elements(tree) {
  return Children.toArray(tree).flatMap(node => isValidElement(node) ? [node, ...elements(node.props.children)] : []);
}

const installed = new WeakMap();

function stubGlobals(t, values, dispose) {
  if (!installed.has(t)) {
    const state = { originals: new Map(), disposers: [] };
    installed.set(t, state);
    t.after(() => {
      try { for (const cleanup of state.disposers.reverse()) cleanup(); }
      finally {
        for (const [key, previous] of state.originals) {
          if (previous) Object.defineProperty(globalThis, key, previous);
          else delete globalThis[key];
        }
      }
    });
  }
  const { originals, disposers } = installed.get(t);
  if (dispose) disposers.push(dispose);
  for (const [key, value] of Object.entries(values)) {
    if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
}

module.exports = { elements, stubGlobals };
