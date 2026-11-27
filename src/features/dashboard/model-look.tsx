// How the page shows a model: one colour and one shape for the whole page.
import { createContext, useContext } from 'react';
import { lookOf, type Look, modelLooks } from './chart-math';

const Context = createContext<Map<string, Look>>(new Map());
export const ModelLooksProvider = Context.Provider;

export type ModelStyle = { look: Look; colour: string };
// The look of any model, read once per component: `of(model)` is a plain function, so loops may call it.
export function useModels() {
  const looks = useContext(Context);
  return {
    of(model: string): ModelStyle {
      const look = looks.get(model) ?? modelLooks([model]).get(model) ?? lookOf(0);
      return { look, colour: look.neutral ? 'var(--text-3)' : `var(--m-${look.colour})` };
    },
  };
}
