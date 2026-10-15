import { ConfigPlugin, withInfoPlist } from "expo/config-plugins";

// iOS terminates an app that touches Bluetooth without this string, and MeshProvider touches
// Bluetooth as soon as it mounts. A value set in `ios.infoPlist` wins over this default.
const DEFAULT_BLUETOOTH_USAGE_DESCRIPTION =
  "Allow $(PRODUCT_NAME) to use Bluetooth to exchange messages with nearby devices.";

const withBleBroadcastIos: ConfigPlugin = (config) =>
  withInfoPlist(config, (config) => {
    config.modResults.NSBluetoothAlwaysUsageDescription ??=
      DEFAULT_BLUETOOTH_USAGE_DESCRIPTION;
    return config;
  });

export default withBleBroadcastIos;
