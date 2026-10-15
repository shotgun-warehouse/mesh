import { useContext, useEffect, useRef } from "react";

import { MeshMessagesContext } from "./MeshContext";
import type { MeshMessageListener } from "./types";

/**
 * Calls `listener` for every message received from the mesh while the component is mounted.
 * The latest `listener` is always used, so it does not need `useCallback`.
 */
export function useMeshMessages(listener: MeshMessageListener): void {
  const subscribe = useContext(MeshMessagesContext);
  if (!subscribe) {
    throw new Error("useMeshMessages must be used within a MeshProvider");
  }

  const listenerRef = useRef(listener);
  useEffect(() => {
    listenerRef.current = listener;
  });

  useEffect(
    () =>
      subscribe((message) => {
        listenerRef.current(message);
      }),
    [subscribe],
  );
}
