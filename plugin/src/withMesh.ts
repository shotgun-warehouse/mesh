import { ConfigPlugin } from "expo/config-plugins";

import withBleBroadcastAndroid from "./withBleBroadcastAndroid";
import withBleBroadcastIos from "./withBleBroadcastIos";

const withMesh: ConfigPlugin = (config) =>
  withBleBroadcastIos(withBleBroadcastAndroid(config));

export default withMesh;
