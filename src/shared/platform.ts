// macOS uses Command where Windows and Linux use Ctrl for copy, paste and links, and draws its own window buttons
// over the title bar. The root element carries the platform for the styles (data-platform="darwin").
export const isMac = navigator.userAgent.includes('Macintosh');
export const isLinux = !isMac && navigator.userAgent.includes('Linux');
export const isWindows = !isMac && !isLinux;
export const commandShortcut = (key: string) => isMac ? '⌘' + key.replace('Shift+', '⇧') : 'Ctrl+' + key;
document.documentElement.dataset.platform = isMac ? 'darwin' : isLinux ? 'linux' : 'win32';
