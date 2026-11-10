import { Check } from '@phosphor-icons/react';
import './native-panel.css';

// The short note after /model, /effort or /fast: what the session runs with now. The hook that holds it takes it away after two seconds.
export function NativeToast({ text }: { text: string }) {
  return <div className="native-toast" role="status"><Check size={16} weight="bold" />{text}</div>;
}
