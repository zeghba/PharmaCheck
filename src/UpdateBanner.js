import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

/*
 * Slides in above the tab bar once a new bundle has been downloaded. Styled to
 * match the web UI's toast so the seam between native and WebView is invisible.
 * Restarting is the user's call — nothing reloads under them mid-task.
 */
export default function UpdateBanner({ visible, onRestart, onDismiss }) {
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(slide, {
      toValue: visible ? 1 : 0,
      duration: 260,
      easing: Easing.bezier(0.22, 0.85, 0.3, 1),
      useNativeDriver: true,
    }).start();
  }, [visible, slide]);

  if (!visible) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        {
          opacity: slide,
          transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
        },
      ]}
    >
      <View style={styles.card}>
        <View style={styles.textCol}>
          <Text style={styles.title}>Update ready</Text>
          <Text style={styles.body}>Restart PharmaCheck to apply the latest version.</Text>
        </View>
        <View style={styles.actions}>
          <Pressable
            onPress={onDismiss}
            hitSlop={8}
            style={({ pressed }) => [styles.later, pressed && styles.pressed]}
          >
            <Text style={styles.laterText}>Later</Text>
          </Pressable>
          <Pressable
            onPress={onRestart}
            hitSlop={8}
            style={({ pressed }) => [styles.restart, pressed && styles.pressed]}
          >
            <Text style={styles.restartText}>Restart</Text>
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 96,
  },
  card: {
    backgroundColor: 'rgba(13, 27, 44, 0.96)',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    shadowColor: '#081628',
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },
  textCol: { marginBottom: 12 },
  title: { color: '#FFFFFF', fontSize: 15, fontWeight: '700', marginBottom: 3 },
  body: { color: 'rgba(255,255,255,0.76)', fontSize: 13, lineHeight: 18 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  later: { paddingVertical: 9, paddingHorizontal: 14, borderRadius: 11 },
  laterText: { color: 'rgba(255,255,255,0.72)', fontSize: 14, fontWeight: '600' },
  restart: { paddingVertical: 9, paddingHorizontal: 18, borderRadius: 11, backgroundColor: '#2B84EF' },
  restartText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  pressed: { opacity: 0.7 },
});
