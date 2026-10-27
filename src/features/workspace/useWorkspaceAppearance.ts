import { useEffect, useLayoutEffect } from 'react';
import type { Workspace } from '../../shared/types';
import { setUserAvatar } from '../../shared/UserAvatar';
import { applyMotion } from '../../shared/motion';
import { applyTheme } from '../../shared/themes';
import { setTerminalRenderer } from '../terminal/terminal-renderer';
import { terminalFontFamily } from '../terminal/terminal-font';

// Apply the workspace's appearance to the shared stylesheet and terminal defaults.
export function useWorkspaceAppearance(workspace: Workspace | null) {
  const settings = workspace?.settings, desktopGlass = workspace?.desktopGlass;
  useLayoutEffect(() => { setUserAvatar(settings?.userAvatar ?? ''); }, [settings?.userAvatar]);
  useEffect(() => { applyMotion(settings?.focusAnimation || 'smooth'); }, [settings?.focusAnimation]);
  useEffect(() => { applyTheme(settings?.theme); }, [settings?.theme]);
  // The surface (glass or solid) is a mode of the whole stylesheet, like the theme.
  useEffect(() => {
    const surface = settings?.surface || 'glass';
    document.documentElement.dataset.surface = surface === 'glass' && settings?.glassBackground === 'desktop' && desktopGlass?.active ? 'desktop-glass' : surface;
  }, [settings?.surface, settings?.glassBackground, desktopGlass?.active]);
  useEffect(() => {
    document.documentElement.dataset.desktopGlassCompatibility = String(!!desktopGlass?.compatibility && (!!desktopGlass?.active || !!desktopGlass?.failed));
  }, [desktopGlass?.compatibility, desktopGlass?.active, desktopGlass?.failed]);
  useEffect(() => {
    const value = settings?.glassTransparency;
    document.documentElement.dataset.glassTransparency = value == null ? 'theme' : 'custom';
    if (settings?.surface !== 'solid' && value != null) document.documentElement.style.setProperty('--glass-alpha', String(1 - value / 100));
    else document.documentElement.style.removeProperty('--glass-alpha');
  }, [settings?.glassTransparency, settings?.surface]);
  useEffect(() => { setTerminalRenderer(settings?.terminalRenderer || 'gpu'); }, [settings?.terminalRenderer]);
  useEffect(() => { document.documentElement.dataset.terminalWeight = String(settings?.terminalFontWeight || 400); }, [settings?.terminalFontWeight]);
  useEffect(() => {
    document.documentElement.dataset.terminalFontFamily = terminalFontFamily(settings?.terminalFontFamily, settings?.terminalCjkFontFamily);
  }, [settings?.terminalFontFamily, settings?.terminalCjkFontFamily]);
}
