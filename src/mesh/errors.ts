import type { MeshStatus } from "./lifecycle";

/**
 * Thrown by `broadcast` when the mesh is not running. Check it with
 * `error instanceof MeshNotRunningError` or `error.code === "ERR_MESH_NOT_RUNNING"`;
 * `error.status` says why (for example `"bluetooth_off"`).
 */
export class MeshNotRunningError extends Error {
  readonly code = "ERR_MESH_NOT_RUNNING";
  readonly status: MeshStatus;

  constructor(status: MeshStatus) {
    super(
      `The mesh is not running (status: "${status}"). broadcast() only works while the status is "running".`,
    );
    this.name = "MeshNotRunningError";
    this.status = status;
  }
}
