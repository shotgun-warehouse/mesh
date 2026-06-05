import {
  AndroidConfig,
  ConfigPlugin,
  withAndroidManifest,
  withGradleProperties,
} from "@expo/config-plugins";
import { execSync } from "child_process";

const LEGACY_BLUETOOTH_PERMISSIONS = [
  "android.permission.BLUETOOTH",
  "android.permission.BLUETOOTH_ADMIN",
] as const;

const MODERN_BLUETOOTH_PERMISSIONS = [
  "android.permission.BLUETOOTH_ADVERTISE",
  "android.permission.BLUETOOTH_CONNECT",
] as const;

const ALL_BLE_PERMISSIONS = [
  ...LEGACY_BLUETOOTH_PERMISSIONS,
  ...MODERN_BLUETOOTH_PERMISSIONS,
  "android.permission.BLUETOOTH_SCAN",
  "android.permission.ACCESS_FINE_LOCATION",
];

function resolveJavaHome(): string | undefined {
  if (process.env.JAVA_HOME) {
    return process.env.JAVA_HOME;
  }

  if (process.platform !== "darwin") {
    return undefined;
  }

  try {
    return execSync("/usr/libexec/java_home -v 17", {
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

const withBleBroadcastAndroid: ConfigPlugin = (config) => {
  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    AndroidConfig.Manifest.ensureToolsAvailable(manifest);

    const permissions = manifest.manifest["uses-permission"] ?? [];
    manifest.manifest["uses-permission"] = permissions.filter((permission) => {
      const permissionName = permission.$?.["android:name"];
      return !ALL_BLE_PERMISSIONS.includes(permissionName ?? "");
    });

    for (const permissionName of LEGACY_BLUETOOTH_PERMISSIONS) {
      manifest.manifest["uses-permission"].push({
        $: {
          "android:name": permissionName,
          "android:maxSdkVersion": "30",
        } as Record<string, string>,
      });
    }

    AndroidConfig.Permissions.ensurePermissions(manifest, [
      ...MODERN_BLUETOOTH_PERMISSIONS,
    ]);

    manifest.manifest["uses-permission"].push({
      $: {
        "android:name": "android.permission.BLUETOOTH_SCAN",
        "android:usesPermissionFlags": "neverForLocation",
      } as Record<string, string>,
    });

    manifest.manifest["uses-permission"].push({
      $: {
        "android:name": "android.permission.ACCESS_FINE_LOCATION",
        "android:maxSdkVersion": "30",
      } as Record<string, string>,
    });

    const features = manifest.manifest["uses-feature"] ?? [];
    const hasBleFeature = features.some(
      (feature) =>
        feature.$?.["android:name"] === "android.hardware.bluetooth_le",
    );

    if (!hasBleFeature) {
      features.push({
        $: {
          "android:name": "android.hardware.bluetooth_le",
          "android:required": "true",
        },
      });
    }

    manifest.manifest["uses-feature"] = features;

    return config;
  });

  return withGradleProperties(config, (config) => {
    const javaHome = resolveJavaHome();
    if (!javaHome) {
      return config;
    }

    const existingIndex = config.modResults.findIndex(
      (item) => item.type === "property" && item.key === "org.gradle.java.home",
    );

    const javaHomeProperty = {
      type: "property" as const,
      key: "org.gradle.java.home",
      value: javaHome,
    };

    if (existingIndex >= 0) {
      config.modResults[existingIndex] = javaHomeProperty;
    } else {
      config.modResults.push(javaHomeProperty);
    }

    return config;
  });
};

export default withBleBroadcastAndroid;
