import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Platform, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import webBundle from './src/webBundle.generated';

/*
 * Native shell around the PharmaCheck Admin web UI.
 *
 * Deliberately thinner than the pharmacy app's shell: no camera, no OTA. This
 * app provisions pharmacies and hands out accounts, so it is installed
 * deliberately on one device and updated by installing a new APK — an app
 * that can create and destroy databases should not be able to rewrite itself
 * from the network.
 *
 * What it does add is what a web page cannot do for itself: the real status
 * bar, safe-area insets, and Android hardware-back routed into the app.
 */

/*
 * The native flag is baked into the markup rather than injected.
 * injectedJavaScriptBeforeContentLoaded fires at onPageStarted on Android,
 * which is not guaranteed to precede the document's own <head> scripts, so a
 * page reading the flag on parse can miss it. Writing it into <head> makes
 * the ordering a property of the document.
 *
 * A replacer function is required: the bundle is full of `$` sequences that
 * String.replace would otherwise expand as match patterns.
 */
const FLAG_TAG = '<head>\n<script>window.__PHARMACHECK_NATIVE__ = true;</script>';
const NATIVE_HTML = webBundle.replace('<head>', () => FLAG_TAG);

if (!NATIVE_HTML.includes('__PHARMACHECK_NATIVE__ = true')) {
  throw new Error('native flag was not injected into the admin web bundle');
}

const BEFORE_LOAD = 'window.__PHARMACHECK_NATIVE__ = true; true;';

const SHELL_BG = '#0B2A4A';
const PAGE_BG = '#F1F5FA';

function Shell() {
  const webRef = useRef(null);
  const [screen, setScreen] = useState('signin');
  const insets = useSafeAreaInsets();

  const onMessage = useCallback((event) => {
    let payload;
    try {
      payload = JSON.parse(event.nativeEvent.data);
    } catch (e) {
      return; // not one of ours
    }
    if (payload && payload.type === 'screen') setScreen(payload.name);
  }, []);

  /*
   * Hardware back is routed into the web app, which knows whether a sheet is
   * open or which screen it can fall back to. Returning false lets Android
   * close the app, and the web side decides when that is right.
   */
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;

    const onBack = () => {
      if (screen === 'signin') return false;
      webRef.current?.injectJavaScript('window.__pharmaadminBack && window.__pharmaadminBack(); true;');
      return true;
    };

    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [screen]);

  /* Android 15+ draws edge to edge; without padding the header slides under
     the clock and the content under the gesture bar. */
  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <StatusBar style="light" backgroundColor={SHELL_BG} />
      <WebView
        ref={webRef}
        source={{ html: NATIVE_HTML, baseUrl: 'https://pharmacheck.admin.local' }}
        originWhitelist={['*']}
        injectedJavaScriptBeforeContentLoaded={BEFORE_LOAD}
        onMessage={onMessage}
        style={styles.web}
        containerStyle={styles.webContainer}
        overScrollMode="never"
        setSupportMultipleWindows={false}
        javaScriptEnabled
        domStorageEnabled
        // The admin app talks to a Worker over https and nothing else.
        mixedContentMode="never"
        allowsBackForwardNavigationGestures={false}
      />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: SHELL_BG },
  web: { flex: 1, backgroundColor: PAGE_BG },
  webContainer: { flex: 1, backgroundColor: PAGE_BG }
});
