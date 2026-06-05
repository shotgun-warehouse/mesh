export class MeshAlreadyStartedError extends Error {
  constructor() {
    super(
      "Mesh session is already started. Call stop() before starting again.",
    );
    this.name = "MeshAlreadyStartedError";
  }
}

export class MeshNotReadyError extends Error {
  constructor() {
    super("Mesh session is not started. Call start() first.");
    this.name = "MeshNotReadyError";
  }
}
