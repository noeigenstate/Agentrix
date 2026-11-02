// How the page shows a model: one colour and one shape for the whole page, and the dimming that follows the model picked in the key.
import { createContext, useContext } from 'react';
import { lookOf, type Look, modelLooks } from './chart-math';

export type ModelPage = { looks: Map<string, Look>; focus: string | null };
const Context = createContext<ModelPage>({ looks: new Map(), focus: null });
export const ModelPageProvider = Context.Provider;

export type ModelStyle = { look: Look; colour: string; dim: string };
// The look of any model, read once per component: `of(model)` is a plain function, so loops may call it.
export function useModels() {
  const { looks, focus } = useContext(Context);
  return {
    focus,
    of(model: string): ModelStyle {
      const look = looks.get(model) ?? modelLooks([model]).get(model) ?? lookOf(0);
      return { look, colour: `var(--m-${look.colour})`, dim: focus !== null && focus !== model ? 'dim' : '' };
    },
  };
}
