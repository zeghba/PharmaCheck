import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Updates from 'expo-updates';

/*
 * Over-the-air update lifecycle for the admin app.
 *
 * States: 'idle' → 'checking' → 'downloading' → 'ready' (or back to 'idle'
 * when there is nothing new). 'ready' means a new bundle is on disk and takes
 * effect on the next reload, which the banner asks the user to trigger.
 *
 * This app can create and destroy databases, so the cautious variant:
 * `checkAutomatically` is NEVER in app.json, which makes this hook the only
 * thing that ever checks, and the running bundle is never swapped underneath
 * a task in progress. Pressing Restart applies the update immediately; left
 * alone, a downloaded update takes effect on the next cold start, the same as
 * any expo-updates app. What it will not do is reload mid-way through
 * provisioning a pharmacy.
 *
 * Checks run on launch and whenever the app returns to the foreground, with a
 * floor between checks so flicking between apps does not hammer the update
 * server. Every failure is non-fatal: an unreachable server or an offline
 * device simply leaves the app on the bundle it already has.
 */

const MIN_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export default function useOtaUpdates() {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const lastCheckedAt = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  const check = useCallback(async ({ force = false } = {}) => {
    // Disabled in Expo Go and in dev builds, where the bundle comes from Metro.
    if (!Updates.isEnabled || __DEV__) return;
    if (inFlight.current) return;
    if (!force && Date.now() - lastCheckedAt.current < MIN_CHECK_INTERVAL_MS) return;

    inFlight.current = true;
    lastCheckedAt.current = Date.now();

    try {
      if (mounted.current) { setStatus('checking'); setError(null); }

      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable) {
        if (mounted.current) setStatus('idle');
        return;
      }

      if (mounted.current) setStatus('downloading');
      const fetched = await Updates.fetchUpdateAsync();

      if (mounted.current) setStatus(fetched.isNew ? 'ready' : 'idle');
    } catch (e) {
      // Offline, server unreachable, or a bad manifest — keep running as is.
      if (mounted.current) { setStatus('idle'); setError(e); }
    } finally {
      inFlight.current = false;
    }
  }, []);

  // On launch, and again each time the app comes back to the foreground.
  useEffect(() => {
    check({ force: true });

    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') check();
    });
    return () => sub.remove();
  }, [check]);

  const applyUpdate = useCallback(async () => {
    try {
      await Updates.reloadAsync();
    } catch (e) {
      if (mounted.current) setError(e);
    }
  }, []);

  return {
    status,
    error,
    isUpdateReady: status === 'ready',
    checkNow: () => check({ force: true }),
    applyUpdate,
    runtimeVersion: Updates.runtimeVersion,
    channel: Updates.channel,
    updateId: Updates.updateId,
    // True when running the bundle compiled into the APK rather than one
    // downloaded over the air.
    isEmbeddedLaunch: Updates.isEmbeddedLaunch,
  };
}
