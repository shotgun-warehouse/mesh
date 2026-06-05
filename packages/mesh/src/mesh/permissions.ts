import { PermissionsAndroid, Platform } from "react-native";

export async function requestMeshPermissions(): Promise<boolean> {
  if (Platform.OS !== "android") {
    return true;
  }

  if (Platform.Version >= 31) {
    const scanResult = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    );
    if (scanResult !== PermissionsAndroid.RESULTS.GRANTED) {
      return false;
    }

    const connectResult = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    );
    if (connectResult !== PermissionsAndroid.RESULTS.GRANTED) {
      return false;
    }

    const advertiseResult = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
    );
    return advertiseResult === PermissionsAndroid.RESULTS.GRANTED;
  }

  const locationResult = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  );
  return locationResult === PermissionsAndroid.RESULTS.GRANTED;
}
