import { Check } from '@phosphor-icons/react';
import './native-panel.css';

// A transient notice above the composer.
export function NativeToast({ text }: { text: string }) {
  return <div className="native-toast" role="status"><Check size={16} weight="bold" />{text}</div>;
}
