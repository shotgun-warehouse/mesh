import { ExpoConfig, ConfigContext } from "expo/config";

const APP_SLUG = "shotgun-mesh-chat";
const BLE_SERVICE_UUID = "0000feed-0000-1000-8000-00805f9b34fb";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Shotgun Mesh Chat",
  slug: APP_SLUG,
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  plugins: ["expo-dev-client", "@shotgun/mesh/plugin"],
  ios: {
    supportsTablet: true,
    bundleIdentifier: "com.shotgun.mesh.chat",
    infoPlist: {
      NSBluetoothAlwaysUsageDescription:
        "Shotgun Mesh uses Bluetooth to broadcast mesh messages to nearby devices.",
      NSBluetoothPeripheralUsageDescription:
        "Shotgun Mesh uses Bluetooth to broadcast mesh messages to nearby devices.",
      UIBackgroundModes: ["bluetooth-peripheral"],
    },
  },
  android: {
    package: "com.shotgun.mesh.chat",
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
    softwareKeyboardLayoutMode: "resize",
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  extra: {
    bleServiceUuid: BLE_SERVICE_UUID,
  },
});
