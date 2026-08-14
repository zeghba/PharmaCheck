import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Platform, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { StatusBar } from 'expo-status-bar';

import webBundle from './src/webBundle.generated';
import useOtaUpdates from './src/useOtaUpdates';
import UpdateBanner from './src/UpdateBanner';

/*
 * Native shell around the PharmaCheck web UI.
 *
 * The whole interface is the inlined HTML bundle rendered in a WebView, so the
 * styling is the same CSS the browser build uses. The shell adds the parts a
 * web page cannot do for itself: OTA updates, the real status bar tinted per
 * screen, and Android hardware-back routing.
 */

// Runs before any document script, so index.html can drop the mock chrome
// before first paint.
const BEFORE_LOAD = 'window.__PHARMACHECK_NATIVE__ = true; true;';

const LIGHT_BG = '#EEF4FB';
const SCANNER_BG = '#0A1420';

export default function App() {
  const webRef = useRef(null);
  const [dark, setDark] = useState(false);
  const [screen, setScreen] = useState('dashboard');
  const [dismissed, setDismissed] = useState(false);

  const { isUpdateReady, applyUpdate } = useOtaUpdates();

  const onMessage = useCallback((event) => {
    let payload;
    try {
      payload = JSON.parse(event.nativeEvent.data);
    } catch (e) {
      return; // not one of ours
    }
    if (payload && payload.type === 'screen') {
      setScreen(payload.name);
      setDark(Boolean(payload.dark));
    }
  }, []);

  // Android back: hand control to the web app until it is already at the
  // dashboard, then let the system close the app.
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;

    const onBack = () => {
      if (screen === 'dashboard') return false;
      webRef.current?.injectJavaScript('window.__pharmacheckBack && window.__pharmacheckBack(); true;');
      return true;
    };

    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [screen]);

  const background = dark ? SCANNER_BG : LIGHT_BG;

  return (
    <View style={[styles.root, { backgroundColor: background }]}>
      <StatusBar style={dark ? 'light' : 'dark'} backgroundColor={background} />

      <WebView
        ref={webRef}
        style={[styles.web, { backgroundColor: background }]}
        originWhitelist={['*']}
        source={{ html: webBundle, baseUrl: 'https://pharmacheck.local' }}
        injectedJavaScriptBeforeContentLoaded={BEFORE_LOAD}
        onMessage={onMessage}
        // The UI is a fixed-size app shell, not a scrollable document.
        scrollEnabled={false}
        overScrollMode="never"
        bounces={false}
        setSupportMultipleWindows={false}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        javaScriptEnabled
        domStorageEnabled
      />

      <UpdateBanner
        visible={isUpdateReady && !dismissed}
        onRestart={applyUpdate}
        onDismiss={() => setDismissed(true)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  web: { flex: 1 },
});
