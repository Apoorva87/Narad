import { useSyncExternalStore } from 'react';
import { defaultSettings, type Settings } from '../../shared/settings';
import { api } from './api';

type Patch = { [Section in keyof Settings]?: Partial<Settings[Section]> };
let current: Settings = defaultSettings;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();
function publish(next: Settings) { current = next; listeners.forEach(listener => listener()); }
function merge(base: Settings, patch: Patch): Settings {
  return Object.fromEntries(Object.entries(base).map(([section, values]) => [section, { ...values, ...(patch[section as keyof Settings] ?? {}) }])) as Settings;
}
/** Server-saved settings for the whole app; defaults apply until the first load finishes. */
export function useSettings(): Settings {
  if (!loading) loading = api.settings().then(response => publish(response.settings)).catch(() => { loading = undefined; });
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => current);
}
/** Applies immediately, then saves; a rejected save restores the previous values and rethrows. */
export async function updateSettings(patch: Patch): Promise<Settings> {
  const previous = current; publish(merge(current, patch));
  try { const response = await api.saveSettings(patch); publish(response.settings); return response.settings; }
  catch (error) { publish(previous); throw error; }
}
export function replaceSettings(next: Settings) { publish(next); }
