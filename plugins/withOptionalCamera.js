/*
 * Declares the camera as an optional device feature.
 *
 * Android implicitly adds <uses-feature android:name="android.hardware.camera"
 * android:required="true"> as soon as CAMERA permission is requested. That
 * makes a camera an install-time requirement, which can block installation on
 * devices whose feature list does not advertise one, and filters the app out
 * on Play. PharmaCheck degrades to manual entry without a camera, so the
 * requirement is wrong.
 *
 * This lives as a config plugin rather than a hand edit because `android/` is
 * generated — `expo prebuild` would discard anything written there directly.
 */
const { withAndroidManifest } = require('expo/config-plugins');

const FEATURES = ['android.hardware.camera', 'android.hardware.camera.autofocus'];

module.exports = function withOptionalCamera(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest['uses-feature'] = manifest['uses-feature'] || [];

    FEATURES.forEach((name) => {
      const existing = manifest['uses-feature'].find(
        (f) => f.$ && f.$['android:name'] === name
      );
      if (existing) {
        existing.$['android:required'] = 'false';
      } else {
        manifest['uses-feature'].push({
          $: { 'android:name': name, 'android:required': 'false' }
        });
      }
    });

    return cfg;
  });
};
