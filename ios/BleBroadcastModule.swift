import ExpoModulesCore
import CoreBluetooth
import UIKit

private let serviceUuid = CBUUID(string: "0000FEED-0000-1000-8000-00805F9B34FB")
private let advertiseServiceUuid = CBUUID(string: "FEED")
private let characteristicUuid = CBUUID(string: "0000BEEF-0000-1000-8000-00805F9B34FB")
/// A central writes its mesh ID here before it subscribes, so the subscription is known by peer.
private let helloCharacteristicUuid = CBUUID(string: "0000BEF0-0000-1000-8000-00805F9B34FB")
private let maxGattPayloadBytes = 4096
private let maxAttWriteBytes = 512
private let minAttWriteBytes = 20
private let localNamePrefix = "SM:"
private let connectionRetryInterval: TimeInterval = 2
private let maxMeshPeers = 8
/// CoreBluetooth's `connect` never times out, so a link must be ready (connected, characteristic
/// found) within this, or it is dropped. Connections normally take under 4 s.
private let linkSetupTimeout: TimeInterval = 10
/// A link still setting up this long gives way to the same peer seen under a new identifier.
private let linkReplaceGrace: TimeInterval = 5
private let outboundWriteAckWarningDelay: TimeInterval = 5
private let maxPendingNotifications = 64
private let meshIdFileName = "expo-mesh-device-id"
private let itemsDirectoryName = "expo-mesh-items"
private let itemsFileSuffix = ".jsonl"

/// Hex (a mesh ID) as bytes; nil when it is not whole bytes of hex.
private func bytesFromHex(_ hex: String) -> Data? {
  guard !hex.isEmpty, hex.count % 2 == 0 else {
    return nil
  }
  var bytes = Data(capacity: hex.count / 2)
  var index = hex.startIndex
  while index < hex.endIndex {
    let nextIndex = hex.index(index, offsetBy: 2)
    guard let byte = UInt8(hex[index..<nextIndex], radix: 16) else {
      return nil
    }
    bytes.append(byte)
    index = nextIndex
  }
  return bytes
}

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

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    module?.handlePeripheralManagerDidReceiveRead(peripheral, request: request)
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didSubscribeTo characteristic: CBCharacteristic
  ) {
    module?.handleCentralSubscribed(central, characteristic: characteristic)
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didUnsubscribeFrom characteristic: CBCharacteristic
  ) {
    module?.handleCentralUnsubscribed(central, characteristic: characteristic)
  }

  func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
    module?.sendPendingNotifications()
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

  func peripheral(_ peripheral: CBPeripheral, didModifyServices invalidatedServices: [CBService]) {
    module?.handlePeripheralDidModifyServices(peripheral, invalidatedServices: invalidatedServices)
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

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    module?.handlePeripheralDidUpdateValue(peripheral, characteristic: characteristic, error: error)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateNotificationStateFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    module?.handlePeripheralDidUpdateNotificationState(peripheral, characteristic: characteristic, error: error)
  }
}

/// A link this device opened to a peer (central role): packets go out as writes.
private struct MeshPeer {
  let deviceId: UUID
  let peripheral: CBPeripheral
  /// The peer's mesh device ID, read from its advertisement. Nil until an advertisement carried it.
  var meshId: String?
  var deviceName: String?
  var rssi: Int
  var meshCharacteristic: CBCharacteristic?
  var isReady: Bool
  /// When link setup started (the connect, or a rediscovery after the peer rebuilt its service).
  var scheduledAt = Date()
}

/// A peer that subscribed to this device's mesh characteristic (peripheral role): packets go out
/// as notifications. It lets this device send to a peer whose own link has not come up.
private struct InboundLink {
  let central: CBCentral
  /// The peer's mesh device ID, from the hello it writes before subscribing. Nil until it arrives.
  var meshId: String?
}

private struct PendingNotification {
  let centralId: UUID
  let payload: Data
}

/// One peer this device can send to, over its own link (preferred: writes are acknowledged) or,
/// when that link is not ready, as a notification over the peer's link to this device.
private struct PeerRoute {
  let meshId: String?
  var outbound: MeshPeer?
  var inbound: (centralId: UUID, link: InboundLink)?
  var linkIds: [String] = []
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

  func removeAll() {
    buffers.removeAll()
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
  /// Bumped on every outbound write, so the ack watchdog knows whether the write it watches is done.
  fileprivate var outboundWriteSerial = 0
  fileprivate var inboundLinks = [UUID: InboundLink]()
  /// Mesh IDs centrals wrote to the hello characteristic. The hello comes before the subscription.
  fileprivate var helloMeshIdByCentral = [UUID: String]()
  /// Notifications CoreBluetooth has not taken yet: `updateValue` refuses them while its queue is full.
  fileprivate var pendingNotifications: [PendingNotification] = []
  /// Last RSSI in each mesh ID's advertisement: the only signal strength of a peer linked inbound only.
  fileprivate var scanRssiByMeshId = [String: Int]()
  fileprivate var lastEmittedBluetoothState: String?
  fileprivate var cachedMeshId: String?
  /// This device's mesh ID, advertised in the local name so peers know who we are before connecting.
  fileprivate var localMeshId: String?

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

    Events("onMessageReceived", "onPeerConnected", "onPeerDisconnected", "onMeshLog", "onBluetoothStateChange")

    // CoreBluetooth managers are created with `queue: nil`, so their delegates run on the main
    // queue. Every function below runs there too, so module state is only touched from one thread.

    OnCreate {
      self.peripheralDelegate.module = self
      self.centralDelegate.module = self
    }

    OnDestroy {
      let peripheralManager = self.peripheralManager
      let centralManager = self.centralManager
      DispatchQueue.main.async {
        if peripheralManager?.state == .poweredOn {
          peripheralManager?.stopAdvertising()
          peripheralManager?.removeAllServices()
        }
        if centralManager?.state == .poweredOn {
          centralManager?.stopScan()
        }
      }
    }

    Constant("deviceName") {
      UIDevice.current.name
    }

    Function("getMeshId") { (byteCount: Int) -> String in
      self.loadOrCreateMeshId(byteCount: byteCount)
    }

    AsyncFunction("getBluetoothStateAsync") { () -> String in
      // Creating the managers shows the Bluetooth permission prompt when it has not been answered yet.
      self.ensureBluetoothManagers()
      return self.currentBluetoothState()
    }.runOnQueue(.main)

    AsyncFunction("startBroadcastAsync") { (meshId: String, promise: Promise) in
      self.localMeshId = meshId.isEmpty ? nil : meshId.lowercased()
      self.startMeshPeripheral(promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("stopBroadcastAsync") {
      self.stopMeshPeripheral()
    }.runOnQueue(.main)

    AsyncFunction("updateBroadcastAsync") { (_: String, promise: Promise) in
      promise.resolve(self.buildResult(for: Data()))
    }.runOnQueue(.main)

    // Module flags, cleared by resetMeshRuntime. JS checks them to notice a reset it missed.
    // (CoreBluetooth's own isAdvertising/isScanning can read false while the app is merely
    // backgrounded, which would restart a healthy mesh on every foreground.)
    AsyncFunction("isBroadcastingAsync") {
      self.isAdvertising
    }.runOnQueue(.main)

    AsyncFunction("startScanAsync") { (promise: Promise) in
      self.startScan(promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("stopScanAsync") {
      self.stopScan()
    }.runOnQueue(.main)

    AsyncFunction("isScanningAsync") {
      self.isScanning
    }.runOnQueue(.main)

    AsyncFunction("sendPacketAsync") { (jsonMessage: String, excludeDeviceId: String?, targetDeviceId: String?, promise: Promise) in
      self.sendPacket(jsonMessage: jsonMessage, excludeDeviceId: excludeDeviceId, targetDeviceId: targetDeviceId, promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("getConnectedPeerCountAsync") {
      self.peerRoutes().count
    }.runOnQueue(.main)

    // Synced items: one append-only file of JSON lines per sync scope (`fileKey` is hex from JS).
    AsyncFunction("readItemsAsync") { (fileKey: String) throws -> [String] in
      try self.itemsQueue.sync { try self.readItemLines(fileKey: fileKey) }
    }

    AsyncFunction("appendItemsAsync") { (fileKey: String, lines: [String]) throws in
      try self.itemsQueue.sync { try self.appendItemLines(fileKey: fileKey, lines: lines) }
    }

    AsyncFunction("listItemFilesAsync") { () throws -> [String] in
      try self.itemsQueue.sync { try self.listItemFileKeys() }
    }

    AsyncFunction("replaceItemsAsync") { (fileKey: String, lines: [String]) throws in
      try self.itemsQueue.sync { try self.replaceItemLines(fileKey: fileKey, lines: lines) }
    }
  }

  /// Serializes item file access: appends from successive JS calls must not interleave.
  private let itemsQueue = DispatchQueue(label: "expo.modules.blebroadcast.items")

  /// `Application Support/expo-mesh-items/<fileKey>.jsonl`, excluded from backups like the mesh ID.
  private func itemsFileUrl(fileKey: String) throws -> URL {
    guard !fileKey.isEmpty, fileKey.allSatisfy({ $0.isHexDigit }) else {
      throw Exception(name: "ERR_MESH_ITEMS_KEY", description: "Invalid items file key")
    }
    return try itemsDirectoryUrl().appendingPathComponent("\(fileKey)\(itemsFileSuffix)")
  }

  private func itemsDirectoryUrl() throws -> URL {
    let fileManager = FileManager.default
    let supportDirectory = try fileManager.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    var directory = supportDirectory.appendingPathComponent(itemsDirectoryName, isDirectory: true)
    if !fileManager.fileExists(atPath: directory.path) {
      try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
      var resourceValues = URLResourceValues()
      resourceValues.isExcludedFromBackup = true
      try? directory.setResourceValues(resourceValues)
    }
    return directory
  }

  private func listItemFileKeys() throws -> [String] {
    let names = try FileManager.default.contentsOfDirectory(atPath: try itemsDirectoryUrl().path)
    return names
      .filter { name in name.hasSuffix(itemsFileSuffix) }
      .map { name in String(name.dropLast(itemsFileSuffix.count)) }
  }

  private func readItemLines(fileKey: String) throws -> [String] {
    let fileUrl = try itemsFileUrl(fileKey: fileKey)
    guard let contents = try? String(contentsOf: fileUrl, encoding: .utf8) else {
      return []
    }
    return contents.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
  }

  private func appendItemLines(fileKey: String, lines: [String]) throws {
    if lines.isEmpty {
      return
    }
    let fileUrl = try itemsFileUrl(fileKey: fileKey)
    let data = Data((lines.joined(separator: "\n") + "\n").utf8)
    if !FileManager.default.fileExists(atPath: fileUrl.path) {
      try data.write(to: fileUrl, options: .atomic)
      return
    }
    let handle = try FileHandle(forWritingTo: fileUrl)
    defer { try? handle.close() }
    try handle.seekToEnd()
    try handle.write(contentsOf: data)
  }

  private func replaceItemLines(fileKey: String, lines: [String]) throws {
    let fileUrl = try itemsFileUrl(fileKey: fileKey)
    if !lines.isEmpty {
      try Data((lines.joined(separator: "\n") + "\n").utf8).write(to: fileUrl, options: .atomic)
    } else if FileManager.default.fileExists(atPath: fileUrl.path) {
      try FileManager.default.removeItem(at: fileUrl)
    }
  }

  /// A random ID of `byteCount` bytes as lowercase hex, generated once per install. It lives in
  /// Application Support, excluded from backups, so restoring a backup on a new phone does not
  /// give two devices the same ID.
  fileprivate func loadOrCreateMeshId(byteCount: Int) -> String {
    let expectedLength = byteCount * 2
    if let cachedMeshId, cachedMeshId.count == expectedLength {
      return cachedMeshId
    }

    let fileManager = FileManager.default
    let supportDirectory = try? fileManager.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let fileUrl = supportDirectory?.appendingPathComponent(meshIdFileName)

    if let fileUrl,
       let storedMeshId = try? String(contentsOf: fileUrl, encoding: .utf8),
       storedMeshId.count == expectedLength,
       storedMeshId.allSatisfy({ $0.isHexDigit }) {
      cachedMeshId = storedMeshId.lowercased()
      return storedMeshId.lowercased()
    }

    let meshId = (0..<byteCount)
      .map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }
      .joined()

    if var fileUrl {
      try? meshId.write(to: fileUrl, atomically: true, encoding: .utf8)
      var resourceValues = URLResourceValues()
      resourceValues.isExcludedFromBackup = true
      try? fileUrl.setResourceValues(resourceValues)
    }

    cachedMeshId = meshId
    return meshId
  }

  /// Both managers opt out of the system "Turn On Bluetooth" alert iOS shows when one is created
  /// while Bluetooth is off: the app gets `poweredOff` through `onBluetoothStateChange` instead and
  /// decides how to tell the user.
  fileprivate func ensureBluetoothManagers() {
    if peripheralManager == nil {
      peripheralManager = CBPeripheralManager(delegate: peripheralDelegate, queue: nil, options: [
        CBPeripheralManagerOptionShowPowerAlertKey: false
      ])
    }
    if centralManager == nil {
      centralManager = CBCentralManager(delegate: centralDelegate, queue: nil, options: [
        CBCentralManagerOptionShowPowerAlertKey: false
      ])
    }
  }

  /// Combined state of both managers, as a `BluetoothState` string for JS.
  /// The mesh needs both roles, so it is `poweredOn` only when both managers are.
  fileprivate func currentBluetoothState() -> String {
    let managerStates = [peripheralManager?.state, centralManager?.state].compactMap { $0 }

    if managerStates.isEmpty {
      switch CBManager.authorization {
      case .denied, .restricted:
        return "unauthorized"
      default:
        return "unknown"
      }
    }

    if managerStates.contains(.unsupported) {
      return "unsupported"
    }
    if managerStates.contains(.unauthorized) {
      return "unauthorized"
    }
    if managerStates.contains(.poweredOff) {
      return "poweredOff"
    }
    if managerStates.count == 2 && managerStates.allSatisfy({ $0 == .poweredOn }) {
      return "poweredOn"
    }
    return "unknown"
  }

  fileprivate func bluetoothUnavailableException(for state: String) -> Exception {
    switch state {
    case "poweredOff":
      return Exception(name: "ERR_BLE_DISABLED", description: "Bluetooth is disabled")
    case "unauthorized":
      return Exception(name: "ERR_BLE_PERMISSION", description: "Bluetooth permission was denied")
    case "unsupported":
      return Exception(name: "ERR_BLE_UNSUPPORTED", description: "Bluetooth LE is not supported on this device")
    default:
      return Exception(name: "ERR_BLE_UNAVAILABLE", description: "Bluetooth is unavailable")
    }
  }

  /// Called whenever either manager reports a new state. Emits `onBluetoothStateChange` when the
  /// combined state changes, and drops all mesh runtime state when Bluetooth stops being usable:
  /// CoreBluetooth stops advertising, clears the GATT database, and invalidates connections
  /// without calling the disconnect delegate.
  fileprivate func handleBluetoothStateUpdate() {
    let state = currentBluetoothState()

    if state != "poweredOn" {
      resetMeshRuntime(bluetoothState: state)
    }

    guard state != lastEmittedBluetoothState else {
      return
    }

    lastEmittedBluetoothState = state
    meshLog("bluetooth", "Bluetooth state changed", detail: ["state": state])
    sendEvent("onBluetoothStateChange", ["state": state])
  }

  fileprivate func resetMeshRuntime(bluetoothState: String) {
    let hadRuntime = isAdvertising || isScanning || !meshPeers.isEmpty || !inboundLinks.isEmpty ||
      activeSendOperation != nil

    isAdvertising = false
    isScanning = false
    payloadCharacteristic = nil

    // An `unknown` state is transient (the managers are initializing): start/scan calls keep
    // waiting for `poweredOn` as before. Any other state is final until the user acts.
    if bluetoothState != "unknown" {
      pendingStartPromise?.reject(bluetoothUnavailableException(for: bluetoothState))
      pendingStartPromise = nil
      pendingScanPromise?.reject(bluetoothUnavailableException(for: bluetoothState))
      pendingScanPromise = nil
    }

    if activeSendOperation != nil {
      failActiveSendOperation(bluetoothUnavailableException(for: bluetoothState))
    }

    let droppedPeers = Array(meshPeers.values)
    let droppedInboundCount = inboundLinks.count
    meshPeers.removeAll()
    pendingConnectionDeviceIds.removeAll()
    lastConnectionAttemptByDevice.removeAll()
    lastEmittedJsonByLink.removeAll()
    incomingWriteAssembler.removeAll()
    scanRssiByMeshId.removeAll()

    for droppedPeer in droppedPeers {
      emitPeerDisconnected(deviceId: droppedPeer.deviceId.uuidString, meshId: droppedPeer.meshId, direction: "outbound")
    }
    dropInboundLinks()

    if hadRuntime {
      meshLog(
        "bluetooth",
        "Bluetooth unavailable — mesh runtime reset",
        detail: [
          "state": bluetoothState,
          "droppedPeerCount": droppedPeers.count,
          "droppedInboundCount": droppedInboundCount
        ],
        level: "warn"
      )
    }
  }

  private func startMeshPeripheral(promise: Promise) {
    ensureBluetoothManagers()
    pendingStartPromise?.reject(Exception(name: "ERR_BLE_STOPPED", description: "Superseded by a newer start call"))
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
    // Calling these while not powered on only logs an API misuse warning; the OS already
    // dropped advertising and services in that case.
    if peripheralManager?.state == .poweredOn {
      peripheralManager?.stopAdvertising()
      peripheralManager?.removeAllServices()
    }
    payloadCharacteristic = nil
    dropInboundLinks()
    isAdvertising = false
    pendingStartPromise?.reject(Exception(name: "ERR_BLE_STOPPED", description: "Mesh peripheral stopped"))
    pendingStartPromise = nil
  }

  /// Sends to every reachable peer once, except the peer behind the link `excludeDeviceId`, or
  /// only to the peer whose mesh ID is `targetDeviceId` when it is set. A peer gets a write over
  /// this device's link to it, or a notification when only its link to this device is up.
  private func sendPacket(jsonMessage: String, excludeDeviceId: String?, targetDeviceId: String?, promise: Promise) {
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
    var notifiedCount = 0
    var skippedExcluded = 0
    var skippedTooLarge = 0
    let routes = peerRoutes()
    // The link a relayed packet came in on, and every other link to the same peer.
    let excludedMeshId = excludeDeviceId.flatMap(meshIdOfLink)

    for route in routes {
      if let excludeDeviceId,
         route.linkIds.contains(excludeDeviceId) || (excludedMeshId != nil && route.meshId == excludedMeshId) {
        skippedExcluded += 1
        continue
      }

      if let targetDeviceId, route.meshId != targetDeviceId.lowercased() {
        continue
      }

      if let meshPeer = route.outbound, let characteristic = meshPeer.meshCharacteristic {
        peerTransfers.append(
          OutboundPeerTransfer(
            peripheral: meshPeer.peripheral,
            characteristic: characteristic,
            payload: payload
          )
        )
      } else if let inbound = route.inbound {
        // A notification is one ATT packet: no long-write equivalent.
        if payload.count > inbound.link.central.maximumUpdateValueLength {
          skippedTooLarge += 1
          continue
        }
        enqueueNotification(centralId: inbound.centralId, payload: payload)
        notifiedCount += 1
      }
    }

    let sentCount = peerTransfers.count + notifiedCount
    let readyPeerCount = routes.count

    meshLog(
      "sendPacket",
      "Outbound packet dispatch queued",
      detail: [
        "payloadBytes": payload.count,
        "wireChars": jsonMessage.count,
        "excludeDeviceId": excludeDeviceId ?? "null",
        "targetDeviceId": targetDeviceId ?? "null",
        "sentCount": sentCount,
        "notifiedCount": notifiedCount,
        "readyPeerCount": readyPeerCount,
        "skippedExcluded": skippedExcluded,
        "skippedTooLarge": skippedTooLarge
      ]
    )

    sendPendingNotifications()

    if peerTransfers.isEmpty {
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

  /// Every peer this device can send to, once each: a peer linked both ways is one route.
  fileprivate func peerRoutes() -> [PeerRoute] {
    var routes = [String: PeerRoute]()

    for meshPeer in meshPeers.values where meshPeer.isReady {
      let linkId = meshPeer.deviceId.uuidString
      let key = meshPeer.meshId ?? "link:\(linkId)"
      var route = routes[key] ?? PeerRoute(meshId: meshPeer.meshId)
      route.outbound = route.outbound ?? meshPeer
      route.linkIds.append(linkId)
      routes[key] = route
    }

    for (centralId, link) in inboundLinks {
      let linkId = centralId.uuidString
      let key = link.meshId ?? "link:\(linkId)"
      var route = routes[key] ?? PeerRoute(meshId: link.meshId)
      route.inbound = route.inbound ?? (centralId: centralId, link: link)
      route.linkIds.append(linkId)
      routes[key] = route
    }

    return Array(routes.values)
  }

  /// The mesh ID of the peer behind a link, in either direction.
  fileprivate func meshIdOfLink(_ linkId: String) -> String? {
    guard let uuid = UUID(uuidString: linkId) else {
      return nil
    }
    return meshPeers[uuid]?.meshId ?? inboundLinks[uuid]?.meshId
  }

  fileprivate func enqueueNotification(centralId: UUID, payload: Data) {
    pendingNotifications.append(PendingNotification(centralId: centralId, payload: payload))
    if pendingNotifications.count > maxPendingNotifications {
      let dropped = pendingNotifications.removeFirst()
      meshLog(
        "gattServer",
        "Notification queue full: dropped the oldest",
        detail: ["linkDeviceId": dropped.centralId.uuidString, "payloadBytes": dropped.payload.count],
        level: "warn"
      )
    }
  }

  /// Hands queued notifications to CoreBluetooth until it refuses one (its queue is full); the
  /// rest go out on `peripheralManagerIsReady(toUpdateSubscribers:)`.
  fileprivate func sendPendingNotifications() {
    guard let peripheralManager, let characteristic = payloadCharacteristic else {
      pendingNotifications.removeAll()
      return
    }

    while let notification = pendingNotifications.first {
      guard let link = inboundLinks[notification.centralId] else {
        pendingNotifications.removeFirst()
        continue
      }
      guard peripheralManager.updateValue(
        notification.payload,
        for: characteristic,
        onSubscribedCentrals: [link.central]
      ) else {
        return
      }
      pendingNotifications.removeFirst()
      meshLog(
        "gattServer",
        "Sent notification",
        detail: [
          "linkDeviceId": notification.centralId.uuidString,
          "meshId": link.meshId ?? "null",
          "payloadBytes": notification.payload.count
        ]
      )
    }
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
      // `.withResponse` always reports 512 (long writes); this one is the real ATT MTU - 3.
      let mtuPayloadLimit = transfer.peripheral.maximumWriteValueLength(for: .withoutResponse)
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
          "mtuPayloadLimit": mtuPayloadLimit,
          "peerIndex": operation.currentPeerIndex + 1,
          "peerCount": operation.peerTransfers.count
        ]
      )
      if chunkData.count > mtuPayloadLimit {
        meshLog(
          "gattClient",
          "Write larger than the MTU: CoreBluetooth sends it as a prepare/execute long write",
          detail: [
            "deviceId": transfer.peripheral.identifier.uuidString,
            "chunkBytes": chunkData.count,
            "mtuPayloadLimit": mtuPayloadLimit
          ],
          level: "warn"
        )
      }

      transfer.peripheral.writeValue(chunkData, for: transfer.characteristic, type: .withResponse)
      watchOutboundWriteAck(deviceId: transfer.peripheral.identifier, chunkBytes: chunkData.count)
      return
    }

    finishActiveSendOperation(operation)
  }

  /// Warns when a write gets no ack: the send queue waits for it, so every later packet waits too.
  fileprivate func watchOutboundWriteAck(deviceId: UUID, chunkBytes: Int) {
    outboundWriteSerial += 1
    let serial = outboundWriteSerial
    let startedAt = Date()
    DispatchQueue.main.asyncAfter(deadline: .now() + outboundWriteAckWarningDelay) { [weak self] in
      guard let self, self.outboundWriteSerial == serial, self.activeSendOperation != nil else {
        return
      }
      self.meshLog(
        "gattClient",
        "Outbound write still not acknowledged",
        detail: [
          "deviceId": deviceId.uuidString,
          "chunkBytes": chunkBytes,
          "waitingMs": Int(Date().timeIntervalSince(startedAt) * 1000),
          "queuedOperations": self.sendOperationQueue.count
        ],
        level: "warn"
      )
    }
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
      dropStaleLinkAfterWriteError(deviceId: deviceId, error: error)
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

    // Queued operations are dropped too; reject them so their JS promises settle.
    for queuedOperation in sendOperationQueue {
      queuedOperation.promise.reject(error)
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

    // Removing the service ends every subscription to it.
    peripheralManager.removeAllServices()
    dropInboundLinks()

    let characteristic = CBMutableCharacteristic(
      type: characteristicUuid,
      properties: [.read, .write, .writeWithoutResponse, .notify],
      value: nil,
      permissions: [.readable, .writeable]
    )
    payloadCharacteristic = characteristic

    let helloCharacteristic = CBMutableCharacteristic(
      type: helloCharacteristicUuid,
      properties: [.write],
      value: nil,
      permissions: [.writeable]
    )

    let service = CBMutableService(type: serviceUuid, primary: true)
    service.characteristics = [characteristic, helloCharacteristic]
    peripheralManager.add(service)
  }

  fileprivate func startAdvertisingPacket() {
    guard let peripheralManager else {
      return
    }

    let advertisementData: [String: Any] = [
      CBAdvertisementDataServiceUUIDsKey: [advertiseServiceUuid],
      // iOS cannot advertise service data, so the mesh ID rides in the local name ("SM:<id>").
      CBAdvertisementDataLocalNameKey: localNamePrefix + (localMeshId ?? "mesh")
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
    if peripheral.state == .poweredOn, let pendingStartPromise {
      do {
        try prepareMeshPeripheral()
      } catch {
        pendingStartPromise.reject(error)
        self.pendingStartPromise = nil
      }
    }

    handleBluetoothStateUpdate()
  }

  fileprivate func handlePeripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    if let error {
      isAdvertising = false
      pendingStartPromise?.reject(Exception(name: "ERR_BLE_GATT", description: error.localizedDescription))
      pendingStartPromise = nil
      return
    }

    // The start promise settles in `peripheralManagerDidStartAdvertising`, so an advertising
    // failure is reported to JS (which retries) instead of leaving a silent, non-advertising node.
    startAdvertisingPacket()
  }

  fileprivate func handlePeripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
    if let error {
      isAdvertising = false
      pendingStartPromise?.reject(Exception(name: "ERR_BLE_ADVERTISE", description: error.localizedDescription))
      pendingStartPromise = nil
      return
    }

    pendingStartPromise?.resolve(buildResult(for: Data()))
    pendingStartPromise = nil
  }

  /// A read of the mesh characteristic returns this device's mesh ID: Android centrals identify the
  /// link with it, as the local name carrying it is not in every advertisement they receive.
  fileprivate func handlePeripheralManagerDidReceiveRead(_ peripheral: CBPeripheralManager, request: CBATTRequest) {
    guard request.characteristic.uuid == characteristicUuid else {
      peripheral.respond(to: request, withResult: .requestNotSupported)
      return
    }

    let meshIdBytes = localMeshId.flatMap(bytesFromHex) ?? Data()
    guard request.offset <= meshIdBytes.count else {
      peripheral.respond(to: request, withResult: .invalidOffset)
      return
    }

    request.value = meshIdBytes.subdata(in: request.offset..<meshIdBytes.count)
    peripheral.respond(to: request, withResult: .success)
  }

  fileprivate func handlePeripheralManagerDidReceiveWrite(_ peripheral: CBPeripheralManager, requests: [CBATTRequest]) {
    for request in requests {
      if request.characteristic.uuid == helloCharacteristicUuid {
        peripheral.respond(to: request, withResult: .success)
        handleHello(central: request.central, value: request.value)
        continue
      }

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

  /// A central wrote its mesh ID before subscribing. When the subscription came first, the link
  /// is reported again now that its peer is known.
  fileprivate func handleHello(central: CBCentral, value: Data?) {
    guard let value, !value.isEmpty else {
      return
    }

    let meshId = value.map { String(format: "%02x", $0) }.joined()
    let centralId = central.identifier
    helloMeshIdByCentral[centralId] = meshId
    meshLog(
      "gattServer",
      "Central introduced itself",
      detail: [
        "linkDeviceId": centralId.uuidString,
        "meshId": meshId,
        "isSubscribed": inboundLinks[centralId] != nil
      ]
    )

    guard var link = inboundLinks[centralId], link.meshId != meshId else {
      return
    }
    link.meshId = meshId
    inboundLinks[centralId] = link
    emitInboundLinkConnected(centralId: centralId, link: link)
  }

  fileprivate func handleCentralSubscribed(_ central: CBCentral, characteristic: CBCharacteristic) {
    guard characteristic.uuid == characteristicUuid else {
      return
    }

    let centralId = central.identifier
    let link = InboundLink(central: central, meshId: helloMeshIdByCentral[centralId])
    inboundLinks[centralId] = link
    meshLog(
      "gattServer",
      "Central subscribed to notifications",
      detail: [
        "linkDeviceId": centralId.uuidString,
        "meshId": link.meshId ?? "null",
        "maximumUpdateValueLength": central.maximumUpdateValueLength
      ]
    )
    emitInboundLinkConnected(centralId: centralId, link: link)
  }

  /// Also called when the central disconnects.
  fileprivate func handleCentralUnsubscribed(_ central: CBCentral, characteristic: CBCharacteristic) {
    guard characteristic.uuid == characteristicUuid else {
      return
    }

    let centralId = central.identifier
    helloMeshIdByCentral.removeValue(forKey: centralId)
    incomingWriteAssembler.remove(centralId: centralId)
    guard let link = inboundLinks.removeValue(forKey: centralId) else {
      return
    }
    pendingNotifications.removeAll { $0.centralId == centralId }
    meshLog(
      "gattServer",
      "Central unsubscribed",
      detail: ["linkDeviceId": centralId.uuidString, "meshId": link.meshId ?? "null"],
      level: "warn"
    )
    emitPeerDisconnected(deviceId: centralId.uuidString, meshId: link.meshId, direction: "inbound")
  }

  fileprivate func emitInboundLinkConnected(centralId: UUID, link: InboundLink) {
    emitPeerConnected(
      deviceId: centralId.uuidString,
      meshId: link.meshId,
      deviceName: nil,
      rssi: link.meshId.flatMap { scanRssiByMeshId[$0] },
      direction: "inbound"
    )
  }

  /// Subscriptions end with the service (mesh stop or restart, Bluetooth off).
  fileprivate func dropInboundLinks() {
    let droppedLinks = inboundLinks
    inboundLinks.removeAll()
    helloMeshIdByCentral.removeAll()
    pendingNotifications.removeAll()
    for (centralId, link) in droppedLinks {
      emitPeerDisconnected(deviceId: centralId.uuidString, meshId: link.meshId, direction: "inbound")
    }
  }

  private func startScan(promise: Promise) {
    if isScanning {
      promise.resolve(nil)
      return
    }

    pendingScanPromise?.reject(Exception(name: "ERR_BLE_STOPPED", description: "Superseded by a newer scan call"))
    pendingScanPromise = promise

    ensureBluetoothManagers()

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
    if centralManager?.state == .poweredOn {
      centralManager?.stopScan()
    }
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
    if central.state == .poweredOn, let pendingScanPromise {
      beginScanning()
      pendingScanPromise.resolve(nil)
      self.pendingScanPromise = nil
    }

    handleBluetoothStateUpdate()
  }

  fileprivate func handleDiscoveredPeripheral(
    _ peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi: Int
  ) {
    guard isMeshAdvertisement(advertisementData) else {
      return
    }

    scheduleMeshConnection(
      for: peripheral,
      rssi: rssi,
      meshId: meshIdFromAdvertisement(advertisementData)
    )
  }

  /// Android peers put their mesh ID in the service data, iOS peers in the local name ("SM:<id>").
  /// The local name may only arrive with the scan response, so the first discovery can lack it.
  fileprivate func meshIdFromAdvertisement(_ advertisementData: [String: Any]) -> String? {
    if let serviceData = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data] {
      for (serviceUuid, data) in serviceData where matchesMeshServiceUuid(serviceUuid) && !data.isEmpty {
        return data.map { String(format: "%02x", $0) }.joined()
      }
    }

    if let localName = advertisementData[CBAdvertisementDataLocalNameKey] as? String,
       localName.hasPrefix(localNamePrefix) {
      let candidate = String(localName.dropFirst(localNamePrefix.count)).lowercased()
      if !candidate.isEmpty && candidate.allSatisfy({ $0.isHexDigit }) {
        return candidate
      }
    }

    return nil
  }

  fileprivate func scheduleMeshConnection(for peripheral: CBPeripheral, rssi: Int, meshId: String?) {
    let deviceId = peripheral.identifier

    if meshId != nil && meshId == localMeshId {
      return
    }

    if let meshId {
      scanRssiByMeshId[meshId] = rssi
    }

    if var existingPeer = meshPeers[deviceId] {
      // Learned the ID after connecting (it came with a later scan response): report it.
      if existingPeer.meshId == nil, let meshId {
        existingPeer.meshId = meshId
        meshPeers[deviceId] = existingPeer
        if existingPeer.isReady {
          emitPeerConnected(
            deviceId: deviceId.uuidString,
            meshId: meshId,
            deviceName: existingPeer.deviceName,
            rssi: existingPeer.rssi,
            direction: "outbound"
          )
        }
      }
      return
    }

    if pendingConnectionDeviceIds.contains(deviceId) {
      return
    }

    // Android rotates its address, so one device can show up under several identifiers. One link
    // per device is enough; the duplicate would only waste one of the peer slots. A link still
    // setting up gives way to the new identifier: a connect to an address the peer no longer uses
    // never completes.
    if let meshId, let existingPeer = meshPeers.values.first(where: { $0.meshId == meshId }) {
      if existingPeer.isReady || Date().timeIntervalSince(existingPeer.scheduledAt) < linkReplaceGrace {
        return
      }
      meshLog(
        "gattClient",
        "Replacing a link that is not ready with the peer's new identifier",
        detail: [
          "meshId": meshId,
          "deviceId": deviceId.uuidString,
          "replacedDeviceId": existingPeer.deviceId.uuidString,
          "peripheralState": existingPeer.peripheral.state.rawValue,
          "pendingMs": Int(Date().timeIntervalSince(existingPeer.scheduledAt) * 1000)
        ],
        level: "warn"
      )
      cleanupMeshPeer(for: existingPeer.deviceId, emitDisconnect: false)
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
      meshId: meshId,
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
        "meshId": meshId ?? "null",
        "deviceName": peripheral.name ?? "null",
        "rssi": rssi
      ]
    )
    centralManager?.connect(peripheral, options: nil)
    watchLinkSetup(deviceId: deviceId)
  }

  /// Drops a link that is not ready `linkSetupTimeout` after its setup started, so the peer's next
  /// advertisement connects again. CoreBluetooth's `connect` never times out, and a peer that
  /// rotated its address never answers on the old one.
  fileprivate func watchLinkSetup(deviceId: UUID) {
    let scheduledAt = meshPeers[deviceId]?.scheduledAt
    DispatchQueue.main.asyncAfter(deadline: .now() + linkSetupTimeout) { [weak self] in
      guard let self,
            let meshPeer = self.meshPeers[deviceId],
            meshPeer.scheduledAt == scheduledAt,
            !meshPeer.isReady else {
        return
      }
      self.meshLog(
        "gattClient",
        "Dropping link to reconnect: not ready in time",
        detail: [
          "deviceId": deviceId.uuidString,
          "meshId": meshPeer.meshId ?? "null",
          "peripheralState": meshPeer.peripheral.state.rawValue,
          "hasCharacteristic": meshPeer.meshCharacteristic != nil,
          "timeoutMs": Int(linkSetupTimeout * 1000)
        ],
        level: "warn"
      )
      // Not ready, so it was never reported (or its disconnect already was).
      self.cleanupMeshPeer(for: deviceId, emitDisconnect: false)
    }
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

    peripheral.discoverCharacteristics([characteristicUuid, helloCharacteristicUuid], for: meshService)
  }

  /// The peer rebuilt its GATT service (Android does on every mesh start, over a link that stays
  /// up): the cached characteristic now points at a dead handle, so rediscover it.
  fileprivate func handlePeripheralDidModifyServices(
    _ peripheral: CBPeripheral,
    invalidatedServices: [CBService]
  ) {
    guard invalidatedServices.contains(where: { matchesMeshServiceUuid($0.uuid) }),
          var meshPeer = meshPeers[peripheral.identifier] else {
      return
    }

    let wasReady = meshPeer.isReady
    meshPeer.meshCharacteristic = nil
    meshPeer.isReady = false
    meshPeer.scheduledAt = Date()
    meshPeers[peripheral.identifier] = meshPeer
    meshLog(
      "gattClient",
      "Peer invalidated the mesh service: rediscovering",
      detail: [
        "deviceId": peripheral.identifier.uuidString,
        "meshId": meshPeer.meshId ?? "null",
        "wasReady": wasReady
      ],
      level: "warn"
    )
    if wasReady {
      emitPeerDisconnected(deviceId: peripheral.identifier.uuidString, meshId: meshPeer.meshId, direction: "outbound")
    }
    peripheral.discoverServices([serviceUuid, advertiseServiceUuid])
    watchLinkSetup(deviceId: peripheral.identifier)
  }

  /// A write to a handle the peer no longer has fails forever: drop the link so it reconnects and
  /// discovers the current one. Skipped when a rediscovery is already under way.
  fileprivate func dropStaleLinkAfterWriteError(deviceId: UUID, error: Error) {
    guard let attError = error as? CBATTError,
          attError.code == .invalidHandle || attError.code == .attributeNotFound,
          meshPeers[deviceId]?.isReady == true else {
      return
    }

    meshLog(
      "gattClient",
      "Dropping link with a stale mesh characteristic",
      detail: [
        "deviceId": deviceId.uuidString,
        "attError": attError.code.rawValue
      ],
      level: "warn"
    )
    cleanupMeshPeer(for: deviceId, emitDisconnect: true)
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

    // Queued ahead of any packet write: the peer learns who subscribes, then can notify this
    // device over this link when its own link here is not up.
    let helloCharacteristic = service.characteristics?.first(where: { $0.uuid == helloCharacteristicUuid })
    if let helloCharacteristic, let helloBytes = localMeshId.flatMap(bytesFromHex) {
      peripheral.writeValue(helloBytes, for: helloCharacteristic, type: .withResponse)
    }
    if characteristic.properties.contains(.notify) {
      peripheral.setNotifyValue(true, for: characteristic)
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
        ),
        "introduced": helloCharacteristic != nil,
        "canNotify": characteristic.properties.contains(.notify)
      ]
    )
    emitPeerConnected(
      deviceId: peripheral.identifier.uuidString,
      meshId: meshPeer.meshId,
      deviceName: peripheral.name,
      rssi: meshPeer.rssi,
      direction: "outbound"
    )
  }

  fileprivate func handlePeripheralDidWriteValue(
    _ peripheral: CBPeripheral,
    characteristic: CBCharacteristic,
    error: Error?
  ) {
    // The hello is not part of a send: only its failure is worth knowing.
    if characteristic.uuid == helloCharacteristicUuid {
      if let error {
        meshLog(
          "gattClient",
          "Hello write failed",
          detail: ["deviceId": peripheral.identifier.uuidString, "error": error.localizedDescription],
          level: "warn"
        )
      }
      return
    }

    completeOutboundWriteAck(
      deviceId: peripheral.identifier,
      payloadBytes: characteristic.value?.count ?? 0,
      error: error
    )
  }

  /// A packet the peer sent as a notification, over this device's link to it.
  fileprivate func handlePeripheralDidUpdateValue(
    _ peripheral: CBPeripheral,
    characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard characteristic.uuid == characteristicUuid,
          error == nil,
          let payload = characteristic.value,
          !payload.isEmpty else {
      return
    }

    let jsonMessage = payload.base64EncodedString()
    let meshPeer = meshPeers[peripheral.identifier]
    meshLog(
      "gattClient",
      "Received notification",
      detail: [
        "deviceId": peripheral.identifier.uuidString,
        "payloadBytes": payload.count,
        "wireChars": jsonMessage.count
      ]
    )
    emitMessage(
      linkDeviceId: peripheral.identifier.uuidString,
      deviceName: peripheral.name,
      rssi: meshPeer?.rssi ?? 0,
      jsonMessage: jsonMessage,
      source: "connection"
    )
  }

  fileprivate func handlePeripheralDidUpdateNotificationState(
    _ peripheral: CBPeripheral,
    characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard characteristic.uuid == characteristicUuid else {
      return
    }
    meshLog(
      "gattClient",
      error == nil ? "Subscribed to the peer's notifications" : "Subscribing to the peer's notifications failed",
      detail: [
        "deviceId": peripheral.identifier.uuidString,
        "isNotifying": characteristic.isNotifying,
        "error": error?.localizedDescription ?? "null"
      ],
      level: error == nil ? "info" : "warn"
    )
  }

  fileprivate func cleanupMeshPeer(for deviceId: UUID, emitDisconnect: Bool) {
    // Only a send writing to this link fails: dropping a link that was never ready (a stuck
    // setup, a replaced identifier) leaves the packet in flight to the other links alone.
    if let operation = activeSendOperation,
       operation.peerTransfers.contains(where: { $0.peripheral.identifier == deviceId }) {
      let writingTo = operation.currentPeerIndex < operation.peerTransfers.count
        ? operation.peerTransfers[operation.currentPeerIndex].peripheral.identifier.uuidString
        : "null"
      meshLog(
        "gattClient",
        "Peer cleanup fails every pending send",
        detail: [
          "deviceId": deviceId.uuidString,
          "isKnownPeer": meshPeers[deviceId] != nil,
          "writingTo": writingTo,
          "queuedOperations": sendOperationQueue.count
        ],
        level: "warn"
      )
      failActiveSendOperation(
        Exception(name: "ERR_BLE_DISCONNECTED", description: "Peer disconnected during outbound write")
      )
    }

    guard let meshPeer = meshPeers.removeValue(forKey: deviceId) else {
      return
    }

    incomingWriteAssembler.remove(centralId: deviceId)
    pendingConnectionDeviceIds.remove(deviceId)
    if centralManager?.state == .poweredOn {
      centralManager?.cancelPeripheralConnection(meshPeer.peripheral)
    }

    // A link that is not ready was never reported, or its disconnect already was.
    if emitDisconnect && meshPeer.isReady {
      emitPeerDisconnected(deviceId: deviceId.uuidString, meshId: meshPeer.meshId, direction: "outbound")
    }
  }

  fileprivate func disconnectAllMeshPeers() {
    for deviceId in meshPeers.keys {
      cleanupMeshPeer(for: deviceId, emitDisconnect: true)
    }
    pendingConnectionDeviceIds.removeAll()
  }

  /// `direction` is `outbound` for a link this device opened, `inbound` for a peer's subscription.
  fileprivate func emitPeerConnected(
    deviceId: String,
    meshId: String?,
    deviceName: String?,
    rssi: Int?,
    direction: String
  ) {
    sendEvent("onPeerConnected", [
      "deviceId": deviceId,
      "meshId": meshId,
      "deviceName": deviceName,
      "rssi": rssi,
      "direction": direction
    ])
  }

  fileprivate func emitPeerDisconnected(deviceId: String, meshId: String?, direction: String) {
    sendEvent("onPeerDisconnected", [
      "deviceId": deviceId,
      "meshId": meshId,
      "direction": direction
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
