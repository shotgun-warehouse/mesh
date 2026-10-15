import { PermissionsAndroid, Platform, type Permission } from "react-native";

/**
 * Shows the Android runtime permission dialog for everything the mesh needs (one "Nearby devices"
 * prompt on Android 12+, location below). iOS has no request API: creating the Bluetooth managers
 * shows its prompt, which `getBluetoothStateAsync` does.
 */
export async function requestMeshPermissions(): Promise<boolean> {
  if (Platform.OS !== "android") {
    return true;
  }

  const permissions: Permission[] =
    Platform.Version >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

  const results = await PermissionsAndroid.requestMultiple(permissions);
  return permissions.every(
    (permission) => results[permission] === PermissionsAndroid.RESULTS.GRANTED,
  );
}
