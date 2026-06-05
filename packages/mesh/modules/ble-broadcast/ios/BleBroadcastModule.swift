import ExpoModulesCore
import CoreBluetooth

private let serviceUuid = CBUUID(string: "0000FEED-0000-1000-8000-00805F9B34FB")
private let advertiseServiceUuid = CBUUID(string: "FEED")
private let characteristicUuid = CBUUID(string: "0000BEEF-0000-1000-8000-00805F9B34FB")
private let maxGattPayloadBytes = 4096
private let maxAttWriteBytes = 512
private let minAttWriteBytes = 20
private let localNamePrefix = "SM:"
private let connectionRetryInterval: TimeInterval = 2
private let maxMeshPeers = 8

private final class BleBroadcastPeripheralDelegate: NSObject, CBPeripheralManagerDelegate {
  weak var module: BleBroadcastModule?

  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    module?.handlePeripheralManagerDidUpdateState(peripheral)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    module?.handlePeripheralManager(peripheral, didAdd: service, error: error)
  }

  func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
    module?.handlePeripheralManagerDidStartAdvertising(peripheral, error: error)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    module?.handlePeripheralManagerDidReceiveWrite(peripheral, requests: requests)
  }
}

private final class BleBroadcastCentralDelegate: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  weak var module: BleBroadcastModule?

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    module?.handleCentralManagerDidUpdateState(central)
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    module?.handleDiscoveredPeripheral(
      peripheral,
      advertisementData: advertisementData,
      rssi: RSSI.intValue
    )
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    module?.handleConnectedPeripheral(peripheral)
  }

  func centralManager(
    _ central: CBCentralManager,
    didFailToConnect peripheral: CBPeripheral,
    error: Error?
  ) {
    module?.handleFailedPeripheralConnection(peripheral)
  }

  func centralManager(
    _ central: CBCentralManager,
    didDisconnectPeripheral peripheral: CBPeripheral,
    error: Error?
  ) {
    module?.handleDisconnectedPeripheral(peripheral)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    module?.handlePeripheralDidDiscoverServices(peripheral, error: error)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didDiscoverCharacteristicsFor service: CBService,
    error: Error?
  ) {
    module?.handlePeripheralDidDiscoverCharacteristics(peripheral, service: service, error: error)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didWriteValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    module?.handlePeripheralDidWriteValue(peripheral, characteristic: characteristic, error: error)
  }
}

private struct MeshPeer {
  let deviceId: UUID
  let peripheral: CBPeripheral
  var deviceName: String?
  var rssi: Int
  var meshCharacteristic: CBCharacteristic?
  var isReady: Bool
}

private struct OutboundPeerTransfer {
  let peripheral: CBPeripheral
  let characteristic: CBCharacteristic
  let payload: Data
  var sentBytes: Int = 0

  var isComplete: Bool {
    sentBytes >= payload.count
  }
}

private struct PendingSendOperation {
  let promise: Promise
  let sentCount: Int
  let readyPeerCount: Int
  let skippedExcluded: Int
  var peerTransfers: [OutboundPeerTransfer]
  var currentPeerIndex: Int = 0
  var activeChunkBytes: Int = 0
}

/// ATT long-write reassembly for inbound GATT server writes (prepare-write chunks by offset).
private final class IncomingAttWriteAssembler {
  private var buffers = [UUID: Data]()

  func accumulate(centralId: UUID, offset: Int, chunk: Data) -> Data {
    var buffer = buffers[centralId] ?? Data()
    let endIndex = offset + chunk.count
    if buffer.count < endIndex {
      buffer.append(Data(repeating: 0, count: endIndex - buffer.count))
    }
    buffer.replaceSubrange(offset..<endIndex, with: chunk)
    buffers[centralId] = buffer
    return buffer
  }

  func takeAssembled(centralId: UUID) -> Data? {
    guard let payload = buffers.removeValue(forKey: centralId), !payload.isEmpty else {
      return nil
    }
    return payload
  }

  func remove(centralId: UUID) {
    buffers.removeValue(forKey: centralId)
  }
}

private enum AttWriteFragmentation {
  static func attPayloadLimit(for peripheral: CBPeripheral) -> Int {
    let negotiatedLimit = peripheral.maximumWriteValueLength(for: .withResponse)
    return max(minAttWriteBytes, min(negotiatedLimit, maxAttWriteBytes))
  }

  static func estimatedAttFragmentCount(payloadBytes: Int, attPayloadLimit: Int) -> Int {
    max(1, (payloadBytes + attPayloadLimit - 1) / attPayloadLimit)
  }

  /// Returns the next outbound ATT segment for a peer transfer.
  /// Payloads larger than one ATT frame are sent in a single CoreBluetooth write so the
  /// stack performs Prepare Write / Execute Write with correct offsets on the wire.
  static func nextOutboundChunk(
    payload: Data,
    sentBytes: Int,
    attPayloadLimit: Int
  ) -> Data? {
    guard sentBytes < payload.count else {
      return nil
    }

    let remaining = payload.count - sentBytes
    if remaining > attPayloadLimit {
      return payload.subdata(in: sentBytes..<payload.count)
    }

    return payload.subdata(in: sentBytes..<(sentBytes + remaining))
  }
}

public class BleBroadcastModule: Module {
  fileprivate var peripheralManager: CBPeripheralManager?
  fileprivate var centralManager: CBCentralManager?
  fileprivate var payloadCharacteristic: CBMutableCharacteristic?
  fileprivate var isAdvertising = false
  fileprivate var isScanning = false
  fileprivate var pendingStartPromise: Promise?
  fileprivate var pendingScanPromise: Promise?
  fileprivate var meshPeers = [UUID: MeshPeer]()
  fileprivate var pendingConnectionDeviceIds = Set<UUID>()
  fileprivate var lastConnectionAttemptByDevice = [UUID: Date]()
  fileprivate var lastEmittedJsonByLink = [String: String]()
  fileprivate let incomingWriteAssembler = IncomingAttWriteAssembler()
  fileprivate var activeSendOperation: PendingSendOperation?
  fileprivate var sendOperationQueue: [PendingSendOperation] = []

  private let peripheralDelegate = BleBroadcastPeripheralDelegate()
  private let centralDelegate = BleBroadcastCentralDelegate()

  fileprivate func meshLog(
    _ tag: String,
    _ message: String,
    detail: [String: Any] = [:],
    level: String = "info"
  ) {
    let detailData = (try? JSONSerialization.data(withJSONObject: detail))
      .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    NSLog("[ShotgunMesh][ios][native][\(tag)] \(message) \(detailData)")
    sendEvent("onMeshLog", [
      "platform": "ios",
      "tag": tag,
      "level": level,
      "message": message,
      "detail": detailData
    ])
  }

  public func definition() -> ModuleDefinition {
    Name("BleBroadcast")

    Events("onMessageReceived", "onPeerConnected", "onPeerDisconnected", "onMeshLog")

    OnCreate {
      self.peripheralDelegate.module = self
      self.centralDelegate.module = self
      self.peripheralManager = CBPeripheralManager(delegate: self.peripheralDelegate, queue: nil, options: [
        CBPeripheralManagerOptionShowPowerAlertKey: true
      ])
    }

    AsyncFunction("startBroadcastAsync") { (_: String, promise: Promise) in
      self.startMeshPeripheral(promise: promise)
    }

    AsyncFunction("stopBroadcastAsync") {
      self.stopMeshPeripheral()
    }

    AsyncFunction("updateBroadcastAsync") { (_: String, promise: Promise) in
      promise.resolve(self.buildResult(for: Data()))
    }

    AsyncFunction("isBroadcastingAsync") {
      self.isAdvertising
    }

    AsyncFunction("startScanAsync") { (promise: Promise) in
      self.startScan(promise: promise)
    }

    AsyncFunction("stopScanAsync") {
      self.stopScan()
    }

    AsyncFunction("isScanningAsync") {
      self.isScanning
    }

    AsyncFunction("sendPacketAsync") { (jsonMessage: String, excludeDeviceId: String?, promise: Promise) in
      self.sendPacket(jsonMessage: jsonMessage, excludeDeviceId: excludeDeviceId, promise: promise)
    }

    AsyncFunction("getConnectedPeerCountAsync") {
      self.meshPeers.values.filter { $0.isReady }.count
    }
  }

  private func startMeshPeripheral(promise: Promise) {
    pendingStartPromise = promise

    guard let peripheralManager else {
      promise.reject(Exception(name: "ERR_BLE_MANAGER", description: "Bluetooth peripheral manager is unavailable"))
      pendingStartPromise = nil
      return
    }

    switch peripheralManager.state {
    case .poweredOn:
      do {
        try prepareMeshPeripheral()
      } catch {
        promise.reject(error)
        pendingStartPromise = nil
      }
    case .poweredOff:
      promise.reject(Exception(name: "ERR_BLE_DISABLED", description: "Bluetooth is disabled"))
      pendingStartPromise = nil
    case .unsupported:
      promise.reject(Exception(name: "ERR_BLE_UNSUPPORTED", description: "Bluetooth LE peripheral mode is not supported on this device"))
      pendingStartPromise = nil
    case .unauthorized:
      promise.reject(Exception(name: "ERR_BLE_PERMISSION", description: "Bluetooth permission was denied"))
      pendingStartPromise = nil
    default:
      break
    }
  }

  private func stopMeshPeripheral() {
    peripheralManager?.stopAdvertising()
    peripheralManager?.removeAllServices()
    payloadCharacteristic = nil
    isAdvertising = false
    pendingStartPromise?.reject(Exception(name: "ERR_BLE_STOPPED", description: "Mesh peripheral stopped"))
    pendingStartPromise = nil
  }

  private func sendPacket(jsonMessage: String, excludeDeviceId: String?, promise: Promise) {
    guard let payload = Data(base64Encoded: jsonMessage) else {
      promise.reject(Exception(name: "ERR_BLE_PAYLOAD", description: "Unable to decode base64 wire payload"))
      return
    }

    if payload.isEmpty {
      promise.reject(Exception(name: "ERR_BLE_PAYLOAD", description: "Wire payload is empty"))
      return
    }

    if payload.count > maxGattPayloadBytes {
      promise.reject(Exception(name: "ERR_BLE_PAYLOAD_TOO_LARGE", description: "JSON payload exceeds the \(maxGattPayloadBytes)-byte GATT limit"))
      return
    }

    var peerTransfers: [OutboundPeerTransfer] = []
    var readyPeerCount = 0
    var skippedExcluded = 0

    for meshPeer in meshPeers.values where meshPeer.isReady {
      readyPeerCount += 1
      let peerId = meshPeer.deviceId.uuidString
      if peerId == excludeDeviceId {
        skippedExcluded += 1
        continue
      }

      guard let characteristic = meshPeer.meshCharacteristic else {
        continue
      }

      peerTransfers.append(
        OutboundPeerTransfer(
          peripheral: meshPeer.peripheral,
          characteristic: characteristic,
          payload: payload
        )
      )
    }

    let sentCount = peerTransfers.count

    meshLog(
      "sendPacket",
      "Outbound packet dispatch queued",
      detail: [
        "payloadBytes": payload.count,
        "wireChars": jsonMessage.count,
        "excludeDeviceId": excludeDeviceId ?? "null",
        "sentCount": sentCount,
        "readyPeerCount": readyPeerCount,
        "skippedExcluded": skippedExcluded
      ]
    )

    if sentCount == 0 {
      promise.resolve([
        "sentCount": sentCount,
        "readyPeerCount": readyPeerCount,
        "skippedExcluded": skippedExcluded
      ])
      return
    }

    let operation = PendingSendOperation(
      promise: promise,
      sentCount: sentCount,
      readyPeerCount: readyPeerCount,
      skippedExcluded: skippedExcluded,
      peerTransfers: peerTransfers
    )
    enqueueSendOperation(operation)
  }

  fileprivate func enqueueSendOperation(_ operation: PendingSendOperation) {
    if activeSendOperation != nil {
      sendOperationQueue.append(operation)
      return
    }

    startSendOperation(operation)
  }

  fileprivate func startSendOperation(_ operation: PendingSendOperation) {
    activeSendOperation = operation
    dispatchNextOutboundWrite()
  }

  fileprivate func dispatchNextOutboundWrite() {
    guard var operation = activeSendOperation else {
      return
    }

    while operation.currentPeerIndex < operation.peerTransfers.count {
      var transfer = operation.peerTransfers[operation.currentPeerIndex]
      if transfer.isComplete {
        operation.currentPeerIndex += 1
        continue
      }

      let attPayloadLimit = AttWriteFragmentation.attPayloadLimit(for: transfer.peripheral)
      guard let chunkData = AttWriteFragmentation.nextOutboundChunk(
        payload: transfer.payload,
        sentBytes: transfer.sentBytes,
        attPayloadLimit: attPayloadLimit
      ) else {
        operation.currentPeerIndex += 1
        continue
      }

      transfer.sentBytes += chunkData.count
      operation.peerTransfers[operation.currentPeerIndex] = transfer
      operation.activeChunkBytes = chunkData.count
      activeSendOperation = operation

      let attFragmentCount = AttWriteFragmentation.estimatedAttFragmentCount(
        payloadBytes: transfer.payload.count,
        attPayloadLimit: attPayloadLimit
      )
      let attFragmentIndex = AttWriteFragmentation.estimatedAttFragmentCount(
        payloadBytes: transfer.sentBytes,
        attPayloadLimit: attPayloadLimit
      ) - 1

      meshLog(
        "gattClient",
        "Sending outbound ATT fragment",
        detail: [
          "deviceId": transfer.peripheral.identifier.uuidString,
          "chunkBytes": chunkData.count,
          "sentBytes": transfer.sentBytes,
          "totalBytes": transfer.payload.count,
          "attPayloadLimit": attPayloadLimit,
          "attFragmentIndex": attFragmentIndex,
          "attFragmentCount": attFragmentCount,
          "usesAttLongWrite": chunkData.count > attPayloadLimit,
          "peerIndex": operation.currentPeerIndex + 1,
          "peerCount": operation.peerTransfers.count
        ]
      )

      transfer.peripheral.writeValue(chunkData, for: transfer.characteristic, type: .withResponse)
      return
    }

    finishActiveSendOperation(operation)
  }

  fileprivate func completeOutboundWriteAck(
    deviceId: UUID,
    payloadBytes: Int,
    error: Error?
  ) {
    if let error {
      meshLog(
        "gattClient",
        "Outbound write failed",
        detail: [
          "deviceId": deviceId.uuidString,
          "payloadBytes": payloadBytes,
          "error": error.localizedDescription
        ],
        level: "error"
      )
      failActiveSendOperation(
        Exception(name: "ERR_BLE_WRITE", description: error.localizedDescription)
      )
      return
    }

    guard var operation = activeSendOperation else {
      return
    }

    if operation.currentPeerIndex < operation.peerTransfers.count {
      let transfer = operation.peerTransfers[operation.currentPeerIndex]
      if !transfer.isComplete {
        activeSendOperation = operation
        dispatchNextOutboundWrite()
        return
      }
    }

    operation.currentPeerIndex += 1
    if operation.currentPeerIndex < operation.peerTransfers.count {
      activeSendOperation = operation
      dispatchNextOutboundWrite()
      return
    }

    finishActiveSendOperation(operation)
  }

  fileprivate func finishActiveSendOperation(_ operation: PendingSendOperation) {
    meshLog(
      "sendPacket",
      "Outbound packet dispatch finished",
      detail: [
        "sentCount": operation.sentCount,
        "readyPeerCount": operation.readyPeerCount,
        "skippedExcluded": operation.skippedExcluded
      ]
    )

    operation.promise.resolve([
      "sentCount": operation.sentCount,
      "readyPeerCount": operation.readyPeerCount,
      "skippedExcluded": operation.skippedExcluded
    ])
    activeSendOperation = nil

    if let nextOperation = sendOperationQueue.first {
      sendOperationQueue.removeFirst()
      startSendOperation(nextOperation)
    }
  }

  fileprivate func failActiveSendOperation(_ error: Exception) {
    if let operation = activeSendOperation {
      operation.promise.reject(error)
    }

    activeSendOperation = nil
    sendOperationQueue.removeAll()
  }

  fileprivate func prepareMeshPeripheral() throws {
    guard let peripheralManager else {
      throw Exception(name: "ERR_BLE_MANAGER", description: "Bluetooth peripheral manager is unavailable")
    }

    if isAdvertising {
      peripheralManager.stopAdvertising()
      isAdvertising = false
    }

    peripheralManager.removeAllServices()

    let characteristic = CBMutableCharacteristic(
      type: characteristicUuid,
      properties: [.read, .write, .writeWithoutResponse],
      value: nil,
      permissions: [.readable, .writeable]
    )
    payloadCharacteristic = characteristic

    let service = CBMutableService(type: serviceUuid, primary: true)
    service.characteristics = [characteristic]
    peripheralManager.add(service)
  }

  fileprivate func startAdvertisingPacket() {
    guard let peripheralManager else {
      return
    }

    let advertisementData: [String: Any] = [
      CBAdvertisementDataServiceUUIDsKey: [advertiseServiceUuid],
      CBAdvertisementDataLocalNameKey: localNamePrefix + "mesh"
    ]

    peripheralManager.startAdvertising(advertisementData)
    isAdvertising = true
  }

  fileprivate func buildResult(for payload: Data) -> [String: Any] {
    return [
      "totalBytes": payload.count,
      "advertisedBytes": 0,
      "truncated": false
    ]
  }

  fileprivate func handlePeripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    guard peripheral.state == .poweredOn, let pendingStartPromise else {
      return
    }

    do {
      try prepareMeshPeripheral()
    } catch {
      pendingStartPromise.reject(error)
      self.pendingStartPromise = nil
    }
  }

  fileprivate func handlePeripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    if let error {
      isAdvertising = false
      pendingStartPromise?.reject(Exception(name: "ERR_BLE_GATT", description: error.localizedDescription))
      pendingStartPromise = nil
      return
    }

    startAdvertisingPacket()
    pendingStartPromise?.resolve(buildResult(for: Data()))
    pendingStartPromise = nil
  }

  fileprivate func handlePeripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
    if let error {
      isAdvertising = false
      pendingStartPromise?.reject(Exception(name: "ERR_BLE_ADVERTISE", description: error.localizedDescription))
      pendingStartPromise = nil
    }
  }

  fileprivate func handlePeripheralManagerDidReceiveWrite(_ peripheral: CBPeripheralManager, requests: [CBATTRequest]) {
    for request in requests {
      guard request.characteristic.uuid == characteristicUuid else {
        peripheral.respond(to: request, withResult: .requestNotSupported)
        continue
      }

      let centralId = request.central.identifier
      let linkDeviceId = centralId.uuidString

      if let chunk = request.value, !chunk.isEmpty {
        let buffer = incomingWriteAssembler.accumulate(
          centralId: centralId,
          offset: request.offset,
          chunk: chunk
        )

        meshLog(
          "gattServer",
          "Accumulated ATT write fragment",
          detail: [
            "linkDeviceId": linkDeviceId,
            "chunkBytes": chunk.count,
            "offset": request.offset,
            "accumulatedBytes": buffer.count,
            "attFragmentIndex": request.offset / maxAttWriteBytes
          ]
        )

        peripheral.respond(to: request, withResult: .success)

        if chunk.count < maxAttWriteBytes {
          guard let payload = incomingWriteAssembler.takeAssembled(centralId: centralId) else {
            continue
          }

          if payload.count > maxGattPayloadBytes {
            meshLog(
              "gattServer",
              "Dropped assembled write — exceeds GATT payload limit",
              detail: [
                "linkDeviceId": linkDeviceId,
                "payloadBytes": payload.count,
                "maxBytes": maxGattPayloadBytes
              ],
              level: "warn"
            )
            continue
          }

          DispatchQueue.main.async { [weak self] in
            self?.emitIncomingWritePayload(
              linkDeviceId: linkDeviceId,
              centralId: centralId,
              payload: payload,
              source: "longWrite"
            )
          }
        }
        continue
      }

      guard let payload = incomingWriteAssembler.takeAssembled(centralId: centralId) else {
        peripheral.respond(to: request, withResult: .invalidAttributeValueLength)
        continue
      }

      if payload.count > maxGattPayloadBytes {
        meshLog(
          "gattServer",
          "Dropped execute-write payload — exceeds GATT payload limit",
          detail: [
            "linkDeviceId": linkDeviceId,
            "payloadBytes": payload.count,
            "maxBytes": maxGattPayloadBytes
          ],
          level: "warn"
        )
        peripheral.respond(to: request, withResult: .invalidAttributeValueLength)
        continue
      }

      peripheral.respond(to: request, withResult: .success)
      DispatchQueue.main.async { [weak self] in
        self?.emitIncomingWritePayload(
          linkDeviceId: linkDeviceId,
          centralId: centralId,
          payload: payload,
          source: "executeWrite"
        )
      }
    }
  }

  fileprivate func emitIncomingWritePayload(
    linkDeviceId: String,
    centralId: UUID,
    payload: Data,
    source: String
  ) {
    guard !payload.isEmpty else {
      meshLog(
        "gattServer",
        "Dropped assembled write — empty payload",
        detail: [
          "linkDeviceId": linkDeviceId,
          "payloadBytes": payload.count
        ],
        level: "warn"
      )
      return
    }

    let jsonMessage = payload.base64EncodedString()

    meshLog(
      "gattServer",
      "Received complete write on mesh characteristic",
      detail: [
        "linkDeviceId": linkDeviceId,
        "payloadBytes": payload.count,
        "wireChars": jsonMessage.count,
        "source": source
      ]
    )
    emitMessage(
      linkDeviceId: linkDeviceId,
      deviceName: nil,
      rssi: meshPeers[centralId]?.rssi ?? 0,
      jsonMessage: jsonMessage,
      source: "connection"
    )
  }

  private func startScan(promise: Promise) {
    if isScanning {
      promise.resolve(nil)
      return
    }

    pendingScanPromise = promise

    if centralManager == nil {
      centralManager = CBCentralManager(delegate: centralDelegate, queue: nil)
    }

    guard let centralManager else {
      promise.reject(Exception(name: "ERR_BLE_MANAGER", description: "Bluetooth central manager is unavailable"))
      pendingScanPromise = nil
      return
    }

    switch centralManager.state {
    case .poweredOn:
      beginScanning()
      promise.resolve(nil)
      pendingScanPromise = nil
    case .poweredOff:
      promise.reject(Exception(name: "ERR_BLE_DISABLED", description: "Bluetooth is disabled"))
      pendingScanPromise = nil
    case .unsupported:
      promise.reject(Exception(name: "ERR_BLE_UNSUPPORTED", description: "Bluetooth LE scanning is not supported on this device"))
      pendingScanPromise = nil
    case .unauthorized:
      promise.reject(Exception(name: "ERR_BLE_PERMISSION", description: "Bluetooth permission was denied"))
      pendingScanPromise = nil
    default:
      break
    }
  }

  private func stopScan() {
    centralManager?.stopScan()
    isScanning = false
    pendingScanPromise?.reject(Exception(name: "ERR_BLE_STOPPED", description: "Scan stopped"))
    pendingScanPromise = nil
    disconnectAllMeshPeers()
  }

  fileprivate func beginScanning() {
    guard let centralManager, centralManager.state == .poweredOn else {
      return
    }

    centralManager.scanForPeripherals(withServices: [serviceUuid, advertiseServiceUuid], options: [
      CBCentralManagerScanOptionAllowDuplicatesKey: true
    ])
    isScanning = true
  }

  fileprivate func handleCentralManagerDidUpdateState(_ central: CBCentralManager) {
    guard central.state == .poweredOn, let pendingScanPromise else {
      return
    }

    beginScanning()
    pendingScanPromise.resolve(nil)
    self.pendingScanPromise = nil
  }

  fileprivate func handleDiscoveredPeripheral(
    _ peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi: Int
  ) {
    guard isMeshAdvertisement(advertisementData) else {
      return
    }

    scheduleMeshConnection(for: peripheral, rssi: rssi)
  }

  fileprivate func scheduleMeshConnection(for peripheral: CBPeripheral, rssi: Int) {
    let deviceId = peripheral.identifier

    if meshPeers[deviceId] != nil || pendingConnectionDeviceIds.contains(deviceId) {
      return
    }

    if meshPeers.count >= maxMeshPeers {
      return
    }

    if let lastAttempt = lastConnectionAttemptByDevice[deviceId],
       Date().timeIntervalSince(lastAttempt) < connectionRetryInterval {
      return
    }

    lastConnectionAttemptByDevice[deviceId] = Date()
    pendingConnectionDeviceIds.insert(deviceId)
    meshPeers[deviceId] = MeshPeer(
      deviceId: deviceId,
      peripheral: peripheral,
      deviceName: peripheral.name,
      rssi: rssi,
      meshCharacteristic: nil,
      isReady: false
    )
    pendingConnectionDeviceIds.remove(deviceId)
    peripheral.delegate = centralDelegate
    meshLog(
      "gattClient",
      "Scheduled mesh connection",
      detail: [
        "deviceId": deviceId.uuidString,
        "deviceName": peripheral.name ?? "null",
        "rssi": rssi
      ]
    )
    centralManager?.connect(peripheral, options: nil)
  }

  fileprivate func handleConnectedPeripheral(_ peripheral: CBPeripheral) {
    meshLog(
      "gattClient",
      "Connected to peer",
      detail: ["deviceId": peripheral.identifier.uuidString]
    )
    peripheral.discoverServices([serviceUuid, advertiseServiceUuid])
  }

  fileprivate func handleFailedPeripheralConnection(_ peripheral: CBPeripheral) {
    meshLog(
      "gattClient",
      "Failed to connect to peer",
      detail: ["deviceId": peripheral.identifier.uuidString],
      level: "error"
    )
    cleanupMeshPeer(for: peripheral.identifier, emitDisconnect: true)
  }

  fileprivate func handleDisconnectedPeripheral(_ peripheral: CBPeripheral) {
    meshLog(
      "gattClient",
      "Disconnected from peer",
      detail: ["deviceId": peripheral.identifier.uuidString],
      level: "warn"
    )
    cleanupMeshPeer(for: peripheral.identifier, emitDisconnect: true)
  }

  fileprivate func handlePeripheralDidDiscoverServices(_ peripheral: CBPeripheral, error: Error?) {
    if error != nil {
      centralManager?.cancelPeripheralConnection(peripheral)
      return
    }

    guard let services = peripheral.services else {
      centralManager?.cancelPeripheralConnection(peripheral)
      return
    }

    let meshService = services.first(where: { matchesMeshServiceUuid($0.uuid) })
    guard let meshService else {
      centralManager?.cancelPeripheralConnection(peripheral)
      return
    }

    peripheral.discoverCharacteristics([characteristicUuid], for: meshService)
  }

  fileprivate func handlePeripheralDidDiscoverCharacteristics(
    _ peripheral: CBPeripheral,
    service: CBService,
    error: Error?
  ) {
    if error != nil {
      centralManager?.cancelPeripheralConnection(peripheral)
      return
    }

    guard let characteristic = service.characteristics?.first(where: { $0.uuid == characteristicUuid }) else {
      centralManager?.cancelPeripheralConnection(peripheral)
      return
    }

    guard var meshPeer = meshPeers[peripheral.identifier] else {
      return
    }

    meshPeer.meshCharacteristic = characteristic
    meshPeer.isReady = true
    meshPeers[peripheral.identifier] = meshPeer
    let attPayloadLimit = AttWriteFragmentation.attPayloadLimit(for: peripheral)
    meshLog(
      "gattClient",
      "Peer link ready",
      detail: [
        "deviceId": peripheral.identifier.uuidString,
        "deviceName": peripheral.name ?? "null",
        "rssi": meshPeer.rssi,
        "readyPeerCount": meshPeers.values.filter { $0.isReady }.count,
        "attPayloadLimit": attPayloadLimit,
        "attFragmentCapacity": AttWriteFragmentation.estimatedAttFragmentCount(
          payloadBytes: maxGattPayloadBytes,
          attPayloadLimit: attPayloadLimit
        )
      ]
    )
    emitPeerConnected(
      deviceId: peripheral.identifier.uuidString,
      deviceName: peripheral.name,
      rssi: meshPeer.rssi
    )
  }

  fileprivate func handlePeripheralDidWriteValue(
    _ peripheral: CBPeripheral,
    characteristic: CBCharacteristic,
    error: Error?
  ) {
    completeOutboundWriteAck(
      deviceId: peripheral.identifier,
      payloadBytes: characteristic.value?.count ?? 0,
      error: error
    )
  }

  fileprivate func cleanupMeshPeer(for deviceId: UUID, emitDisconnect: Bool) {
    if activeSendOperation != nil {
      failActiveSendOperation(
        Exception(name: "ERR_BLE_DISCONNECTED", description: "Peer disconnected during outbound write")
      )
    }

    guard let meshPeer = meshPeers.removeValue(forKey: deviceId) else {
      return
    }

    incomingWriteAssembler.remove(centralId: deviceId)
    pendingConnectionDeviceIds.remove(deviceId)
    centralManager?.cancelPeripheralConnection(meshPeer.peripheral)

    if emitDisconnect {
      emitPeerDisconnected(deviceId: deviceId.uuidString)
    }
  }

  fileprivate func disconnectAllMeshPeers() {
    for deviceId in meshPeers.keys {
      cleanupMeshPeer(for: deviceId, emitDisconnect: true)
    }
    pendingConnectionDeviceIds.removeAll()
  }

  fileprivate func emitPeerConnected(deviceId: String, deviceName: String?, rssi: Int) {
    sendEvent("onPeerConnected", [
      "deviceId": deviceId,
      "deviceName": deviceName,
      "rssi": rssi
    ])
  }

  fileprivate func emitPeerDisconnected(deviceId: String) {
    sendEvent("onPeerDisconnected", [
      "deviceId": deviceId
    ])
  }

  fileprivate func emitMessage(
    linkDeviceId: String,
    deviceName: String?,
    rssi: Int,
    jsonMessage: String,
    source: String
  ) {
    let dedupeKey = "\(linkDeviceId):\(jsonMessage)"
    if lastEmittedJsonByLink[dedupeKey] == jsonMessage {
      meshLog(
        "receive",
        "Dropped duplicate payload on link",
        detail: [
          "linkDeviceId": linkDeviceId,
          "wireChars": jsonMessage.count
        ],
        level: "debug"
      )
      return
    }

    lastEmittedJsonByLink[dedupeKey] = jsonMessage

    meshLog(
      "receive",
      "Emitting packet to JS",
      detail: [
        "linkDeviceId": linkDeviceId,
        "source": source,
        "wireChars": jsonMessage.count,
        "deviceName": deviceName ?? "null"
      ]
    )

    sendEvent("onMessageReceived", [
      "deviceId": linkDeviceId,
      "viaDeviceId": linkDeviceId,
      "deviceName": deviceName,
      "jsonMessage": jsonMessage,
      "rssi": rssi,
      "truncated": false,
      "source": source,
      "timestamp": Int(Date().timeIntervalSince1970 * 1000)
    ])
  }

  fileprivate func isMeshAdvertisement(_ advertisementData: [String: Any]) -> Bool {
    if let localName = advertisementData[CBAdvertisementDataLocalNameKey] as? String,
       localName.hasPrefix(localNamePrefix) {
      return true
    }

    if let serviceUuids = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] {
      return serviceUuids.contains(where: { matchesMeshServiceUuid($0) })
    }

    return false
  }

  fileprivate func matchesMeshServiceUuid(_ candidateUuid: CBUUID) -> Bool {
    return candidateUuid == serviceUuid ||
      candidateUuid == advertiseServiceUuid ||
      candidateUuid.uuidString.uppercased().contains("FEED")
  }
}
