import { PermissionsAndroid, Platform, type Permission } from "react-native";

/**
 * - `granted`: the mesh has every permission it needs.
 * - `denied`: the user saw the dialog and denied it.
 * - `unanswered`: no dialog showed. Android drops a request made while another one is on screen
 *   (another library asking at launch) and answers it as never-ask-again, which is also what it
 *   answers once the user denied for good; asking again is silent then. A request with no
 *   activity to show it fails the same way.
 */
export type MeshPermissionResult = "granted" | "denied" | "unanswered";

/**
 * Shows the Android runtime permission dialog for everything the mesh needs (one "Nearby devices"
 * prompt on Android 12+, location below). iOS has no request API: creating the Bluetooth managers
 * shows its prompt, which `getBluetoothStateAsync` does.
 */
export async function requestMeshPermissions(): Promise<MeshPermissionResult> {
  if (Platform.OS !== "android") {
    return "granted";
  }

  const permissions: Permission[] =
    Platform.Version >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

  const results = await PermissionsAndroid.requestMultiple(permissions).catch(
    () => null,
  );
  if (results === null) {
    return "unanswered";
  }
  if (
    permissions.every(
      (permission) =>
        results[permission] === PermissionsAndroid.RESULTS.GRANTED,
    )
  ) {
    return "granted";
  }
  return permissions.some(
    (permission) => results[permission] === PermissionsAndroid.RESULTS.DENIED,
  )
    ? "denied"
    : "unanswered";
}
