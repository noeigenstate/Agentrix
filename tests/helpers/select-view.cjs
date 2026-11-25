const { hookHarness } = require('./hook-harness.cjs');
const { elements, stubGlobals } = require('./renderer-fixtures.cjs');

function selectRows(t, options, value) {
  const noop = () => {};
  const Check = () => null;
  const view = hookHarness('src/shared/Select.tsx', {
    'react-dom': { createPortal: child => child },
    '@phosphor-icons/react': { Check, CaretDown: noop },
  });
  t.after(() => view.dispose());
  stubGlobals(t, { document: { body: {}, addEventListener: noop, removeEventListener: noop }, addEventListener: noop, removeEventListener: noop });
  const props = { label: 'Fixture', options, value, onChange: noop };
  elements(view.render('Select', props).result).find(node => node.props.role === 'combobox').props.onClick();
  const rows = elements(view.render('Select', props).result).filter(node => node.props.role === 'option');
  return { rows, Check };
}

module.exports = { selectRows };
