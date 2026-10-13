import { useContext } from "react";

import { MeshContext } from "./MeshContext";

export function useMesh() {
  const context = useContext(MeshContext);
  if (!context) {
    throw new Error("useMesh must be used within a MeshProvider");
  }
  return context;
}
