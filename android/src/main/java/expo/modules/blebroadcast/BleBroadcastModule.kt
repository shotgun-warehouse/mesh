package expo.modules.blebroadcast

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.provider.Settings
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import org.json.JSONObject
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import java.io.File
import java.security.SecureRandom
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

class BleBroadcastModule : Module() {
  private val serviceUuid = UUID.fromString(SERVICE_UUID)
  private val characteristicUuid = UUID.fromString(CHARACTERISTIC_UUID)

  private var bluetoothManager: BluetoothManager? = null
  private var bluetoothAdapter: BluetoothAdapter? = null
  private var advertiser: BluetoothLeAdvertiser? = null
  private var scanner: BluetoothLeScanner? = null
  private var gattServer: BluetoothGattServer? = null
  private var payloadCharacteristic: BluetoothGattCharacteristic? = null
  private var isAdvertising = false
  private var isScanning = false
  private var pendingStartPromise: Promise? = null

  private val meshPeers = mutableMapOf<String, MeshPeer>()
  private val pendingConnectionDeviceIds = mutableSetOf<String>()
  private val lastConnectionAttemptByDevice = mutableMapOf<String, Long>()
  private val lastEmittedJsonByLink = mutableMapOf<String, String>()
  /** Buffers in-progress BLE long writes (prepare-write chunks) keyed by device address. */
  private val preparedWriteBuffers = mutableMapOf<String, ByteArray>()
  /** Peers whose cached GATT table proved stale (invalid handle): cleared on their next connect. */
  private val staleGattCacheDeviceIds = mutableSetOf<String>()
  /**
   * MTU a peer negotiated when it connected to this GATT server. The ATT MTU belongs to the
   * connection, which both directions share: with it known, this device's own MTU request is
   * skipped (iOS can leave it unanswered, which blocks every later GATT operation).
   */
  private val serverMtuByDeviceId = mutableMapOf<String, Int>()
  private var lastEmittedBluetoothState: String? = null
  private var cachedMeshId: String? = null
  /** This device's mesh ID, advertised as service data so peers know who we are before connecting. */
  private var localMeshId: String? = null
  private var isBluetoothStateReceiverRegistered = false

  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  private fun meshLog(
    tag: String,
    message: String,
    detail: Map<String, Any?> = emptyMap(),
    level: String = "info",
  ) {
    val detailJson = JSONObject()
    for ((key, value) in detail) {
      if (value != null) {
        detailJson.put(key, value)
      }
    }

    Log.println(
      when (level) {
        "error" -> Log.ERROR
        "warn" -> Log.WARN
        else -> Log.INFO
      },
      "ShotgunMesh",
      "[android][native][$tag] $message $detailJson",
    )

    sendEvent(
      "onMeshLog",
      mapOf(
        "platform" to "android",
        "tag" to tag,
        "level" to level,
        "message" to message,
        "detail" to detailJson.toString(),
      ),
    )
  }

  private data class MeshPeer(
    val deviceId: String,
    val gatt: BluetoothGatt,
    /** The peer's mesh device ID, read from its advertisement. Null until an advertisement carried it. */
    var meshId: String?,
    var deviceName: String?,
    var rssi: Int,
    var meshCharacteristic: BluetoothGattCharacteristic?,
    var isReady: Boolean = false,
    var isDiscovering: Boolean = false,
    var discoveryAttempts: Int = 0,
    /** Failed writes in a row on this link; reset by any successful write. */
    var consecutiveWriteFailures: Int = 0,
  )

  private data class OutboundPeerTransfer(
    val peer: MeshPeer,
    val payload: ByteArray,
    var sentBytes: Int = 0,
  ) {
    val isComplete: Boolean
      get() = sentBytes >= payload.size
  }

  private class PendingSendOperation(
    val promise: Promise,
    val sentCount: Int,
    val readyPeerCount: Int,
    val skippedExcluded: Int,
    val peerTransfers: List<OutboundPeerTransfer>,
    var currentPeerIndex: Int = 0,
  )

  private var activeSendOperation: PendingSendOperation? = null
  private val sendOperationQueue = ArrayDeque<PendingSendOperation>()
  private val mainHandler = Handler(Looper.getMainLooper())

  private object AttWriteFragmentation {
    private const val MIN_ATT_WRITE_BYTES = 20

    fun attPayloadLimit(): Int = MAX_ATT_WRITE_BYTES

    fun estimatedAttFragmentCount(payloadBytes: Int): Int {
      val attPayloadLimit = attPayloadLimit()
      return maxOf(1, (payloadBytes + attPayloadLimit - 1) / attPayloadLimit)
    }

    /** One CoreBluetooth/GATT write; the stack long-writes when payload exceeds one ATT frame. */
    fun nextOutboundChunk(payload: ByteArray, sentBytes: Int): ByteArray? {
      if (sentBytes >= payload.size) {
        return null
      }

      val remaining = payload.size - sentBytes
      val attPayloadLimit = attPayloadLimit()
      if (remaining > attPayloadLimit) {
        return payload.copyOfRange(sentBytes, payload.size)
      }

      return payload.copyOfRange(sentBytes, sentBytes + remaining)
    }
  }

  private val gattServerCallback = object : BluetoothGattServerCallback() {
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      meshLog(
        tag = "gattServer",
        message = "Central connection state changed",
        detail = mapOf(
          "deviceId" to device.address,
          "status" to status,
          "newState" to newState,
        ),
      )
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        // Link-ready events are emitted from the GATT client once the mesh
        // characteristic is discovered — avoid premature connect events here.
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        preparedWriteBuffers.remove(device.address)
        serverMtuByDeviceId.remove(device.address)
        // Disconnect is handled from the GATT client peer lifecycle.
      }
    }

    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
      serverMtuByDeviceId[device.address] = mtu
      meshLog(
        tag = "gattServer",
        message = "Central MTU changed",
        detail = mapOf("deviceId" to device.address, "mtu" to mtu),
      )
    }

    override fun onExecuteWrite(device: BluetoothDevice, requestId: Int, execute: Boolean) {
      // Not answered: the central waits for its ATT timeout (30 s) before its next write.
      meshLog(
        tag = "gattServer",
        message = "Execute write request left unanswered",
        detail = mapOf(
          "deviceId" to device.address,
          "execute" to execute,
          "bufferedBytes" to (preparedWriteBuffers[device.address]?.size ?: 0),
        ),
        level = "warn",
      )
    }

    override fun onCharacteristicReadRequest(
      device: BluetoothDevice,
      requestId: Int,
      offset: Int,
      characteristic: BluetoothGattCharacteristic,
    ) {
      val server = gattServer ?: return
      val payload = characteristic.value ?: ByteArray(0)

      if (offset > payload.size) {
        server.sendResponse(device, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null)
        return
      }

      val endIndex = minOf(offset + MAX_GATT_READ_CHUNK_BYTES, payload.size)
      val value = payload.copyOfRange(offset, endIndex)
      server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?,
    ) {
      val server = gattServer
      if (server == null) {
        // No response: the central's write waits for its ATT timeout, and its send queue with it.
        meshLog(
          tag = "gattServer",
          message = "Write request ignored: GATT server is gone",
          detail = mapOf("deviceId" to device.address, "bytes" to (value?.size ?: 0)),
          level = "warn",
        )
        return
      }
      val chunk = value ?: ByteArray(0)
      val deviceId = device.address

      if (preparedWrite) {
        // The packet was larger than the link's MTU. Chunks under 512 bytes are taken as the last
        // one below, so a long write over a smaller MTU emits cut-off payloads.
        meshLog(
          tag = "gattServer",
          message = "Prepared (long) write chunk",
          detail = mapOf(
            "deviceId" to deviceId,
            "chunkBytes" to chunk.size,
            "offset" to offset,
            "responseNeeded" to responseNeeded,
          ),
          level = "warn",
        )
        if (chunk.isNotEmpty()) {
          val accumulatedBytes = accumulatePreparedWrite(deviceId, offset, chunk)
          meshLog(
            tag = "gattServer",
            message = "Accumulated prepared write chunk",
            detail = mapOf(
              "deviceId" to deviceId,
              "chunkBytes" to chunk.size,
              "offset" to offset,
              "accumulatedBytes" to accumulatedBytes.size,
            ),
          )

          if (responseNeeded) {
            server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, chunk)
          }

          // Some centrals omit an explicit execute after the final prepare chunk.
          if (chunk.size < MAX_ATT_WRITE_BYTES) {
            val assembledPayload = preparedWriteBuffers.remove(deviceId) ?: accumulatedBytes
            queueAssembledWriteEmit(
              device = device,
              characteristic = characteristic,
              payload = assembledPayload,
              source = "longWrite",
            )
          }
        } else if (responseNeeded) {
          server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, chunk)
        }
        return
      }

      val payload = when {
        preparedWriteBuffers.containsKey(deviceId) -> {
          val accumulated = preparedWriteBuffers.remove(deviceId)!!
          if (chunk.isNotEmpty()) chunk else accumulated
        }
        else -> chunk
      }

      if (responseNeeded) {
        server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, chunk)
      }

      if (payload.isEmpty()) {
        return
      }

      queueAssembledWriteEmit(
        device = device,
        characteristic = characteristic,
        payload = payload,
        source = "connection",
      )
      return
    }
  }

  private val meshClientCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      val peer = meshPeers[gatt.device.address]
      if (peer == null) {
        gatt.close()
        return
      }

      when (newState) {
        BluetoothProfile.STATE_CONNECTED -> {
          meshLog(
            tag = "gattClient",
            message = "Connected to peer",
            detail = mapOf("deviceId" to gatt.device.address, "status" to status),
          )
          // Only after an invalid handle: a refresh right before discovery made it never answer.
          if (staleGattCacheDeviceIds.remove(gatt.device.address)) {
            meshLog(
              tag = "gattClient",
              message = "Cleared the stale GATT cache",
              detail = mapOf(
                "deviceId" to gatt.device.address,
                "refreshed" to refreshGattCache(gatt),
              ),
            )
          }
          // Discovery first, MTU after (`markLinkReady`): an MTU request iOS leaves unanswered
          // blocks every GATT operation queued behind it, discovery included.
          mainHandler.postDelayed({ discoverMeshServices(gatt) }, MTU_SETTLE_DELAY_MS)
          watchLinkSetup(gatt)
        }
        BluetoothProfile.STATE_DISCONNECTED -> {
          meshLog(
            tag = "gattClient",
            message = "Disconnected from peer",
            detail = mapOf("deviceId" to gatt.device.address, "status" to status),
            level = "warn",
          )
          cleanupMeshPeer(gatt.device.address, emitDisconnect = true)
        }
      }
    }

    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      if (meshPeers[gatt.device.address] == null) {
        return
      }
      meshLog(
        tag = "gattClient",
        message = "MTU changed",
        detail = mapOf(
          "deviceId" to gatt.device.address,
          "mtu" to mtu,
          "status" to status,
          "attPayloadLimit" to AttWriteFragmentation.attPayloadLimit(),
        ),
      )
      markLinkReady(gatt)
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      val peer = meshPeers[gatt.device.address] ?: return
      peer.isDiscovering = false

      if (status != BluetoothGatt.GATT_SUCCESS) {
        meshLog(
          tag = "gattClient",
          message = "Service discovery failed",
          detail = mapOf("deviceId" to gatt.device.address, "status" to status),
          level = "error",
        )
        gatt.disconnect()
        return
      }

      val meshService = gatt.getService(serviceUuid)
      val characteristic = meshService?.getCharacteristic(characteristicUuid)
      if (characteristic == null) {
        meshLog(
          tag = "gattClient",
          message = "Mesh characteristic not found; disconnecting",
          detail = mapOf(
            "deviceId" to gatt.device.address,
            "hasService" to (meshService != null),
            "serviceCount" to gatt.services.size,
          ),
          level = "warn",
        )
        gatt.disconnect()
        return
      }

      peer.meshCharacteristic = characteristic
      val serverMtu = serverMtuByDeviceId[gatt.device.address]
      if (serverMtu != null) {
        markLinkReady(gatt)
        return
      }
      // Writes wait for the MTU (they would be refused while the request is in flight), but not
      // forever: iOS can leave it unanswered.
      val requested = gatt.requestMtu(517)
      meshLog(
        tag = "gattClient",
        message = "Requesting MTU",
        detail = mapOf("deviceId" to gatt.device.address, "requested" to requested),
      )
      if (!requested) {
        markLinkReady(gatt)
        return
      }
      mainHandler.postDelayed({ markLinkReady(gatt) }, MTU_WAIT_MS)
    }

    /** The mesh characteristic is known and the MTU settled (or given up on): writes can start. */
    private fun markLinkReady(gatt: BluetoothGatt) {
      val peer = meshPeers[gatt.device.address] ?: return
      if (peer.gatt !== gatt || peer.isReady || peer.meshCharacteristic == null) {
        return
      }
      peer.isReady = true
      meshLog(
        tag = "gattClient",
        message = "Peer link ready",
        detail = mapOf(
          "deviceId" to peer.deviceId,
          "deviceName" to peer.deviceName,
          "rssi" to peer.rssi,
          "readyPeerCount" to meshPeers.values.count { readyPeer -> readyPeer.isReady },
          "attPayloadLimit" to AttWriteFragmentation.attPayloadLimit(),
          "serverMtu" to serverMtuByDeviceId[gatt.device.address],
        ),
      )
      emitPeerConnected(peer.deviceId, peer.meshId, peer.deviceName, peer.rssi)
    }

    override fun onCharacteristicWrite(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int,
    ) {
      val peer = meshPeers[gatt.device.address]
      if (status != BluetoothGatt.GATT_SUCCESS) {
        val failures = (peer?.consecutiveWriteFailures ?: 0) + 1
        peer?.consecutiveWriteFailures = failures
        meshLog(
          tag = "gattClient",
          message = "Outbound write failed",
          detail = mapOf(
            "deviceId" to gatt.device.address,
            "status" to status,
            "payloadBytes" to (characteristic.value?.size ?: 0),
            "consecutiveFailures" to failures,
          ),
          level = "error",
        )
        failActiveSendOperation(
          CodedException(
            code = "ERR_BLE_WRITE",
            message = "Outbound write failed with status $status",
            cause = null,
          ),
        )
        // The link stays "ready" while every write fails (e.g. handles from a stale GATT cache):
        // reconnect so services are discovered again.
        if (status == ATT_INVALID_HANDLE) {
          staleGattCacheDeviceIds.add(gatt.device.address)
        }
        if (status == ATT_INVALID_HANDLE || failures >= MAX_CONSECUTIVE_WRITE_FAILURES) {
          dropMeshPeer(
            gatt.device.address,
            "Writes keep failing",
            mapOf("status" to status, "consecutiveFailures" to failures),
          )
        }
        return
      }

      peer?.consecutiveWriteFailures = 0
      completeOutboundWriteAck()
    }
  }

  private val advertiseCallback = object : AdvertiseCallback() {
    override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
      isAdvertising = true
      pendingStartPromise?.resolve(buildResult(ByteArray(0)))
      pendingStartPromise = null
    }

    override fun onStartFailure(errorCode: Int) {
      isAdvertising = false
      pendingStartPromise?.reject(
        "ERR_BLE_ADVERTISE",
        "Failed to start BLE advertising (error code: $errorCode)",
        null,
      )
      pendingStartPromise = null
    }
  }

  private val bluetoothStateReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.action == BluetoothAdapter.ACTION_STATE_CHANGED) {
        handleBluetoothStateUpdate()
      }
    }
  }

  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      handleScanResult(result)
    }

    override fun onBatchScanResults(results: MutableList<ScanResult>) {
      for (scanResult in results) {
        handleScanResult(scanResult)
      }
    }

    override fun onScanFailed(errorCode: Int) {
      isScanning = false
    }
  }

  override fun definition() = ModuleDefinition {
    Name("BleBroadcast")

    Events("onMessageReceived", "onPeerConnected", "onPeerDisconnected", "onMeshLog", "onBluetoothStateChange")

    // Lifecycle functions run on the main thread, like the Bluetooth state receiver, so a
    // start/stop from JS never interleaves with the runtime reset on Bluetooth power-off.

    OnCreate {
      registerBluetoothStateReceiver()
    }

    OnDestroy {
      unregisterBluetoothStateReceiver()
      runCatching { stopScan() }
      runCatching { stopMeshPeripheral() }
    }

    Constant("deviceName") {
      readDeviceName()
    }

    Function("getMeshId") { byteCount: Int ->
      loadOrCreateMeshId(byteCount)
    }

    AsyncFunction("getBluetoothStateAsync") {
      currentBluetoothState()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("startBroadcastAsync") { meshId: String, promise: Promise ->
      localMeshId = meshId.lowercase().takeIf { id -> id.isNotEmpty() }
      startMeshPeripheral(promise)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stopBroadcastAsync") {
      stopMeshPeripheral()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("updateBroadcastAsync") { _jsonMessage: String, promise: Promise ->
      promise.resolve(buildResult(ByteArray(0)))
    }

    AsyncFunction("isBroadcastingAsync") {
      isAdvertising
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("startScanAsync") { promise: Promise ->
      startScan(promise)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stopScanAsync") {
      stopScan()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("isScanningAsync") {
      isScanning
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("sendPacketAsync") { jsonMessage: String, excludeDeviceId: String?, targetDeviceId: String?, promise: Promise ->
      sendPacket(jsonMessage, excludeDeviceId, targetDeviceId, promise)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("getConnectedPeerCountAsync") {
      meshPeers.values.count { peer -> peer.isReady }
    }.runOnQueue(Queues.MAIN)

    // Synced items: one append-only file of JSON lines per sync scope (`fileKey` is hex from JS).
    AsyncFunction("readItemsAsync") { fileKey: String ->
      synchronized(itemsLock) {
        val file = itemsFile(fileKey)
        if (!file.exists()) emptyList() else file.readLines().filter { line -> line.isNotEmpty() }
      }
    }

    AsyncFunction("appendItemsAsync") { fileKey: String, lines: List<String> ->
      synchronized(itemsLock) {
        if (lines.isNotEmpty()) {
          itemsFile(fileKey).appendText(lines.joinToString(separator = "\n", postfix = "\n"))
        }
      }
    }

    AsyncFunction("listItemFilesAsync") {
      synchronized(itemsLock) {
        val names = itemsDirectory().list() ?: emptyArray()
        names
          .filter { name -> name.endsWith(ITEMS_FILE_SUFFIX) }
          .map { name -> name.removeSuffix(ITEMS_FILE_SUFFIX) }
      }
    }

    AsyncFunction("replaceItemsAsync") { fileKey: String, lines: List<String> ->
      synchronized(itemsLock) {
        val file = itemsFile(fileKey)
        if (lines.isEmpty()) {
          file.delete()
        } else {
          // Write aside then rename, so a kill mid-write leaves the old file whole.
          val tempFile = File(file.parentFile, "${file.name}.tmp")
          tempFile.writeText(lines.joinToString(separator = "\n", postfix = "\n"))
          if (!tempFile.renameTo(file)) {
            tempFile.delete()
            throw CodedException("ERR_MESH_ITEMS_WRITE", "Could not replace items file", null)
          }
        }
      }
      Unit
    }
  }

  /** Serializes item file access: appends from successive JS calls must not interleave. */
  private val itemsLock = Any()

  /** `noBackupFilesDir/expo-mesh-items/<fileKey>.jsonl`, never restored onto another phone. */
  private fun itemsFile(fileKey: String): File {
    if (fileKey.isEmpty() || !fileKey.all { char -> char in HEX_DIGITS }) {
      throw CodedException("ERR_MESH_ITEMS_KEY", "Invalid items file key", null)
    }
    return File(itemsDirectory(), "$fileKey$ITEMS_FILE_SUFFIX")
  }

  private fun itemsDirectory(): File {
    val context = appContext.reactContext
      ?: throw CodedException("ERR_MESH_ITEMS_CONTEXT", "No React context", null)
    val directory = File(context.noBackupFilesDir, ITEMS_DIRECTORY_NAME)
    directory.mkdirs()
    return directory
  }

  /**
   * A random ID of `byteCount` bytes as lowercase hex, generated once per install. It is stored in
   * `noBackupFilesDir`, so Auto Backup never restores it onto a second phone.
   */
  private fun loadOrCreateMeshId(byteCount: Int): String {
    val expectedLength = byteCount * 2
    cachedMeshId?.takeIf { id -> id.length == expectedLength }?.let { id -> return id }

    val idFile = appContext.reactContext?.let { reactContext -> File(reactContext.noBackupFilesDir, MESH_ID_FILE_NAME) }
    val storedMeshId = runCatching { idFile?.readText()?.trim()?.lowercase() }.getOrNull()
    if (storedMeshId != null && storedMeshId.length == expectedLength && storedMeshId.all { char -> char in HEX_DIGITS }) {
      cachedMeshId = storedMeshId
      return storedMeshId
    }

    val randomBytes = ByteArray(byteCount).also { bytes -> SecureRandom().nextBytes(bytes) }
    val meshId = bytesToHex(randomBytes)
    runCatching { idFile?.writeText(meshId) }
    cachedMeshId = meshId
    return meshId
  }

  private fun bytesToHex(bytes: ByteArray): String =
    bytes.joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }

  private fun hexToBytes(hex: String): ByteArray? {
    if (hex.isEmpty() || hex.length % 2 != 0 || !hex.all { char -> char in HEX_DIGITS }) {
      return null
    }
    return ByteArray(hex.length / 2) { index -> hex.substring(index * 2, index * 2 + 2).toInt(16).toByte() }
  }

  /** Android peers put their mesh ID in the service data, iOS peers in the local name ("SM:<id>"). */
  private fun meshIdFromScanRecord(record: android.bluetooth.le.ScanRecord): String? {
    val serviceData = record.getServiceData(ParcelUuid(serviceUuid))
    if (serviceData != null && serviceData.isNotEmpty()) {
      return bytesToHex(serviceData)
    }

    val localName = record.deviceName ?: return null
    if (!localName.startsWith(LOCAL_NAME_PREFIX)) {
      return null
    }
    val candidate = localName.removePrefix(LOCAL_NAME_PREFIX).lowercase()
    return candidate.takeIf { id -> id.isNotEmpty() && id.all { char -> char in HEX_DIGITS } }
  }

  private fun registerBluetoothStateReceiver() {
    val reactContext = appContext.reactContext ?: return
    if (isBluetoothStateReceiverRegistered) {
      return
    }

    // ACTION_STATE_CHANGED is a protected broadcast (only the system can send it), and the
    // receiver re-reads the adapter state instead of trusting the intent extras.
    ContextCompat.registerReceiver(
      reactContext,
      bluetoothStateReceiver,
      IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED),
      ContextCompat.RECEIVER_EXPORTED,
    )
    isBluetoothStateReceiverRegistered = true
  }

  private fun unregisterBluetoothStateReceiver() {
    if (!isBluetoothStateReceiverRegistered) {
      return
    }

    runCatching { appContext.reactContext?.unregisterReceiver(bluetoothStateReceiver) }
    isBluetoothStateReceiverRegistered = false
  }

  private fun readDeviceName(): String? {
    val reactContext = appContext.reactContext ?: return Build.MODEL
    val deviceName = runCatching {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.S) {
        Settings.Secure.getString(reactContext.contentResolver, "bluetooth_name")
      } else {
        Settings.Global.getString(reactContext.contentResolver, Settings.Global.DEVICE_NAME)
      }
    }.getOrNull()

    return deviceName?.takeIf { name -> name.isNotBlank() } ?: Build.MODEL
  }

  private fun hasMeshPermissions(reactContext: Context): Boolean {
    val requiredPermissions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      listOf(
        android.Manifest.permission.BLUETOOTH_SCAN,
        android.Manifest.permission.BLUETOOTH_CONNECT,
        android.Manifest.permission.BLUETOOTH_ADVERTISE,
      )
    } else {
      listOf(android.Manifest.permission.ACCESS_FINE_LOCATION)
    }

    return requiredPermissions.all { permission ->
      ContextCompat.checkSelfPermission(reactContext, permission) == PackageManager.PERMISSION_GRANTED
    }
  }

  /** Current availability as a `BluetoothState` string for JS (names follow CoreBluetooth). */
  private fun currentBluetoothState(): String {
    val reactContext = appContext.reactContext ?: return BLUETOOTH_STATE_UNKNOWN

    if (!reactContext.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
      return BLUETOOTH_STATE_UNSUPPORTED
    }

    val adapter = (reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
      ?: return BLUETOOTH_STATE_UNSUPPORTED

    if (!hasMeshPermissions(reactContext)) {
      return BLUETOOTH_STATE_UNAUTHORIZED
    }

    return when (adapter.state) {
      // The advertiser is only null while the adapter is on when peripheral mode is unsupported.
      // Without multiple-advertisement support the device cannot be a peripheral, so it can never
      // join the mesh; since Android 8 the advertiser object exists even then.
      BluetoothAdapter.STATE_ON ->
        if (!adapter.isMultipleAdvertisementSupported || adapter.bluetoothLeAdvertiser == null) {
          BLUETOOTH_STATE_UNSUPPORTED
        } else {
          BLUETOOTH_STATE_POWERED_ON
        }
      BluetoothAdapter.STATE_TURNING_ON -> BLUETOOTH_STATE_UNKNOWN
      else -> BLUETOOTH_STATE_POWERED_OFF
    }
  }

  private fun bluetoothUnavailableException(bluetoothState: String): CodedException {
    return when (bluetoothState) {
      BLUETOOTH_STATE_POWERED_OFF -> CodedException(code = "ERR_BLE_DISABLED", message = "Bluetooth is disabled", cause = null)
      BLUETOOTH_STATE_UNAUTHORIZED -> CodedException(code = "ERR_BLE_PERMISSION", message = "Bluetooth permission was denied", cause = null)
      BLUETOOTH_STATE_UNSUPPORTED -> CodedException(code = "ERR_BLE_UNSUPPORTED", message = "Bluetooth LE is not supported on this device", cause = null)
      else -> CodedException(code = "ERR_BLE_UNAVAILABLE", message = "Bluetooth is unavailable", cause = null)
    }
  }

  /**
   * Runs on the main thread for every adapter state broadcast. Emits `onBluetoothStateChange` when
   * the state changes, and drops all mesh runtime state when Bluetooth stops being usable: the
   * stack stops advertising and scanning and drops GATT links on power-off.
   */
  private fun handleBluetoothStateUpdate() {
    val bluetoothState = currentBluetoothState()

    if (bluetoothState != BLUETOOTH_STATE_POWERED_ON) {
      resetMeshRuntime(bluetoothState)
    }

    if (bluetoothState == lastEmittedBluetoothState) {
      return
    }

    lastEmittedBluetoothState = bluetoothState
    meshLog(
      tag = "bluetooth",
      message = "Bluetooth state changed",
      detail = mapOf("state" to bluetoothState),
    )
    sendEvent("onBluetoothStateChange", mapOf("state" to bluetoothState))
  }

  private fun resetMeshRuntime(bluetoothState: String) {
    val hadRuntime = isAdvertising || isScanning || gattServer != null || meshPeers.isNotEmpty() || activeSendOperation != null
    val droppedPeerCount = meshPeers.size

    // The adapter may already be off: these throw IllegalStateException in that case.
    if (isAdvertising || pendingStartPromise != null) {
      runCatching { advertiser?.stopAdvertising(advertiseCallback) }
    }
    isAdvertising = false
    if (isScanning) {
      runCatching { scanner?.stopScan(scanCallback) }
    }
    isScanning = false
    runCatching { gattServer?.close() }
    gattServer = null
    payloadCharacteristic = null

    val unavailableError = bluetoothUnavailableException(bluetoothState)
    pendingStartPromise?.reject(unavailableError.code, unavailableError.message, unavailableError)
    pendingStartPromise = null

    if (activeSendOperation != null) {
      failActiveSendOperation(unavailableError)
    }

    disconnectAllMeshPeers()
    preparedWriteBuffers.clear()
    lastConnectionAttemptByDevice.clear()
    lastEmittedJsonByLink.clear()

    if (hadRuntime) {
      meshLog(
        tag = "bluetooth",
        message = "Bluetooth unavailable — mesh runtime reset",
        detail = mapOf("state" to bluetoothState, "droppedPeerCount" to droppedPeerCount),
        level = "warn",
      )
    }
  }

  private fun startMeshPeripheral(promise: Promise) {
    try {
      ensureBluetoothAdapterReady(requireAdvertiser = true)
      ensureBroadcastPermissions()
      setupGattServer()

      if (isAdvertising) {
        advertiser?.stopAdvertising(advertiseCallback)
        isAdvertising = false
      }

      val advertiseDataBuilder = AdvertiseData.Builder()
        .setIncludeDeviceName(false)
        .addServiceUuid(ParcelUuid(serviceUuid))
      localMeshId?.let(::hexToBytes)?.let { meshIdBytes ->
        advertiseDataBuilder.addServiceData(ParcelUuid(serviceUuid), meshIdBytes)
      }
      val advertiseData = advertiseDataBuilder.build()

      val settings = AdvertiseSettings.Builder()
        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
        .setConnectable(true)
        .build()

      pendingStartPromise?.reject("ERR_BLE_STOPPED", "Superseded by a newer start call", null)
      pendingStartPromise = promise
      advertiser?.startAdvertising(settings, advertiseData, advertiseCallback)
    } catch (error: CodedException) {
      promise.reject(error.code, error.message, error)
    }
  }

  private fun stopMeshPeripheral() {
    // Also stop when a start is still pending, or a late onStartSuccess would leave us advertising.
    // stopAdvertising throws IllegalStateException when the adapter is already off.
    if (isAdvertising || pendingStartPromise != null) {
      runCatching { advertiser?.stopAdvertising(advertiseCallback) }
      isAdvertising = false
    }

    runCatching { gattServer?.close() }
    gattServer = null
    payloadCharacteristic = null
    pendingStartPromise?.reject("ERR_BLE_STOPPED", "Mesh peripheral stopped", null)
    pendingStartPromise = null
  }

  /**
   * Writes to every ready link except [excludeDeviceId], or only to the link whose advertised mesh
   * ID is [targetDeviceId] when it is set.
   */
  private fun sendPacket(jsonMessage: String, excludeDeviceId: String?, targetDeviceId: String?, promise: Promise) {
    try {
      ensureBluetoothAdapterReady(requireAdvertiser = false)
      ensureScanPermissions()

      val payload = try {
        Base64.decode(jsonMessage, Base64.NO_WRAP)
      } catch (error: IllegalArgumentException) {
        promise.reject("ERR_BLE_PAYLOAD", "Unable to decode base64 wire payload", error)
        return
      }

      if (payload.isEmpty()) {
        promise.reject("ERR_BLE_PAYLOAD", "Wire payload is empty", null)
        return
      }

      validatePayloadSize(payload)

      val peerTransfers = mutableListOf<OutboundPeerTransfer>()
      var readyPeerCount = 0
      var skippedNotReady = 0
      var skippedExcluded = 0
      var writeQueueFailures = 0

      for (peer in meshPeers.values) {
        if (!peer.isReady) {
          skippedNotReady += 1
          continue
        }

        readyPeerCount += 1

        if (peer.deviceId == excludeDeviceId) {
          skippedExcluded += 1
          continue
        }

        if (targetDeviceId != null && peer.meshId != targetDeviceId.lowercase()) {
          continue
        }

        val characteristic = peer.meshCharacteristic
        if (characteristic == null) {
          writeQueueFailures += 1
          continue
        }

        peerTransfers.add(OutboundPeerTransfer(peer = peer, payload = payload))
      }

      val sentCount = peerTransfers.size

      meshLog(
        tag = "sendPacket",
        message = "Outbound packet dispatch queued",
        detail = mapOf(
          "payloadBytes" to payload.size,
          "wireChars" to jsonMessage.length,
          "excludeDeviceId" to excludeDeviceId,
          "targetDeviceId" to targetDeviceId,
          "sentCount" to sentCount,
          "readyPeerCount" to readyPeerCount,
          "skippedNotReady" to skippedNotReady,
          "skippedExcluded" to skippedExcluded,
          "writeQueueFailures" to writeQueueFailures,
        ),
      )

      if (sentCount == 0) {
        promise.resolve(
          mapOf(
            "sentCount" to sentCount,
            "readyPeerCount" to readyPeerCount,
            "skippedExcluded" to skippedExcluded,
          ),
        )
        return
      }

      enqueueSendOperation(
        PendingSendOperation(
          promise = promise,
          sentCount = sentCount,
          readyPeerCount = readyPeerCount,
          skippedExcluded = skippedExcluded,
          peerTransfers = peerTransfers,
        ),
      )
    } catch (error: CodedException) {
      promise.reject(error.code, error.message, error)
    }
  }

  private fun enqueueSendOperation(operation: PendingSendOperation) {
    if (activeSendOperation != null) {
      sendOperationQueue.addLast(operation)
      return
    }

    startSendOperation(operation)
  }

  private fun startSendOperation(operation: PendingSendOperation) {
    activeSendOperation = operation
    dispatchNextOutboundWrite()
  }

  private fun dispatchNextOutboundWrite() {
    val operation = activeSendOperation ?: return

    while (operation.currentPeerIndex < operation.peerTransfers.size) {
      val transfer = operation.peerTransfers[operation.currentPeerIndex]
      if (transfer.isComplete) {
        operation.currentPeerIndex += 1
        continue
      }

      val chunk = AttWriteFragmentation.nextOutboundChunk(
        payload = transfer.payload,
        sentBytes = transfer.sentBytes,
      )
      if (chunk == null) {
        operation.currentPeerIndex += 1
        continue
      }

      val characteristic = transfer.peer.meshCharacteristic
      if (characteristic == null) {
        operation.currentPeerIndex += 1
        continue
      }

      transfer.sentBytes += chunk.size

      val attFragmentCount = AttWriteFragmentation.estimatedAttFragmentCount(transfer.payload.size)
      val attFragmentIndex = AttWriteFragmentation.estimatedAttFragmentCount(transfer.sentBytes) - 1

      meshLog(
        tag = "gattClient",
        message = "Sending outbound ATT fragment",
        detail = mapOf(
          "deviceId" to transfer.peer.deviceId,
          "chunkBytes" to chunk.size,
          "sentBytes" to transfer.sentBytes,
          "totalBytes" to transfer.payload.size,
          "attPayloadLimit" to AttWriteFragmentation.attPayloadLimit(),
          "attFragmentIndex" to attFragmentIndex,
          "attFragmentCount" to attFragmentCount,
          "usesAttLongWrite" to (chunk.size > AttWriteFragmentation.attPayloadLimit()),
          "peerIndex" to (operation.currentPeerIndex + 1),
          "peerCount" to operation.peerTransfers.size,
        ),
      )

      characteristic.value = chunk
      characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
      val queued = transfer.peer.gatt.writeCharacteristic(characteristic)
      if (!queued) {
        meshLog(
          tag = "sendPacket",
          message = "writeCharacteristic returned false",
          detail = mapOf(
            "deviceId" to transfer.peer.deviceId,
            "payloadBytes" to chunk.size,
          ),
          level = "warn",
        )
        failActiveSendOperation(
          CodedException(
            code = "ERR_BLE_WRITE",
            message = "writeCharacteristic returned false",
            cause = null,
          ),
        )
        return
      }
      return
    }

    finishActiveSendOperation(operation)
  }

  private fun completeOutboundWriteAck() {
    val operation = activeSendOperation ?: return

    if (operation.currentPeerIndex < operation.peerTransfers.size) {
      val transfer = operation.peerTransfers[operation.currentPeerIndex]
      if (!transfer.isComplete) {
        dispatchNextOutboundWrite()
        return
      }
    }

    operation.currentPeerIndex += 1
    if (operation.currentPeerIndex < operation.peerTransfers.size) {
      dispatchNextOutboundWrite()
      return
    }

    finishActiveSendOperation(operation)
  }

  private fun finishActiveSendOperation(operation: PendingSendOperation) {
    meshLog(
      tag = "sendPacket",
      message = "Outbound packet dispatch finished",
      detail = mapOf(
        "sentCount" to operation.sentCount,
        "readyPeerCount" to operation.readyPeerCount,
        "skippedExcluded" to operation.skippedExcluded,
      ),
    )

    operation.promise.resolve(
      mapOf(
        "sentCount" to operation.sentCount,
        "readyPeerCount" to operation.readyPeerCount,
        "skippedExcluded" to operation.skippedExcluded,
      ),
    )
    activeSendOperation = null

    val nextOperation = sendOperationQueue.removeFirstOrNull()
    if (nextOperation != null) {
      startSendOperation(nextOperation)
    }
  }

  private fun failActiveSendOperation(error: CodedException) {
    activeSendOperation?.promise?.reject(error.code, error.message, error)
    // Queued operations are dropped too; reject them so their JS promises settle.
    for (queuedOperation in sendOperationQueue) {
      queuedOperation.promise.reject(error.code, error.message, error)
    }
    activeSendOperation = null
    sendOperationQueue.clear()
  }

  private fun ensureBluetoothAdapterReady(requireAdvertiser: Boolean) {
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
      throw CodedException(
        code = "ERR_BLE_UNSUPPORTED",
        message = "Bluetooth LE is not supported on this device",
        cause = null,
      )
    }

    bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    bluetoothAdapter = bluetoothManager?.adapter

    if (bluetoothAdapter == null || !bluetoothAdapter!!.isEnabled) {
      throw CodedException(
        code = "ERR_BLE_DISABLED",
        message = "Bluetooth is disabled",
        cause = null,
      )
    }

    if (requireAdvertiser) {
      advertiser = bluetoothAdapter?.bluetoothLeAdvertiser
      if (advertiser == null) {
        throw CodedException(
          code = "ERR_BLE_ADVERTISER",
          message = "BLE advertiser is unavailable on this device",
          cause = null,
        )
      }
    }

    scanner = bluetoothAdapter?.bluetoothLeScanner
  }

  private fun ensureBroadcastPermissions() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val advertiseGranted = ContextCompat.checkSelfPermission(
        context,
        android.Manifest.permission.BLUETOOTH_ADVERTISE,
      ) == PackageManager.PERMISSION_GRANTED

      val connectGranted = ContextCompat.checkSelfPermission(
        context,
        android.Manifest.permission.BLUETOOTH_CONNECT,
      ) == PackageManager.PERMISSION_GRANTED

      if (!advertiseGranted || !connectGranted) {
        throw CodedException(
          code = "ERR_BLE_PERMISSION",
          message = "Bluetooth advertise/connect permissions are required before broadcasting",
          cause = null,
        )
      }
    }
  }

  private fun ensureScanPermissions() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val scanGranted = ContextCompat.checkSelfPermission(
        context,
        android.Manifest.permission.BLUETOOTH_SCAN,
      ) == PackageManager.PERMISSION_GRANTED

      val connectGranted = ContextCompat.checkSelfPermission(
        context,
        android.Manifest.permission.BLUETOOTH_CONNECT,
      ) == PackageManager.PERMISSION_GRANTED

      if (!scanGranted || !connectGranted) {
        throw CodedException(
          code = "ERR_BLE_PERMISSION",
          message = "Bluetooth scan/connect permissions are required before scanning",
          cause = null,
        )
      }
      return
    }

    val locationGranted = ContextCompat.checkSelfPermission(
      context,
      android.Manifest.permission.ACCESS_FINE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED

    if (!locationGranted) {
      throw CodedException(
        code = "ERR_BLE_PERMISSION",
        message = "Location permission is required for BLE scanning on this Android version",
        cause = null,
      )
    }
  }

  private fun validatePayloadSize(payload: ByteArray) {
    if (payload.size > MAX_GATT_PAYLOAD_BYTES) {
      throw CodedException(
        code = "ERR_BLE_PAYLOAD_TOO_LARGE",
        message = "JSON payload exceeds the ${MAX_GATT_PAYLOAD_BYTES}-byte GATT limit",
        cause = null,
      )
    }
  }

  private fun startScan(promise: Promise) {
    try {
      ensureBluetoothAdapterReady(requireAdvertiser = false)
      ensureScanPermissions()

      val activeScanner = scanner ?: throw CodedException(
        code = "ERR_BLE_SCANNER",
        message = "BLE scanner is unavailable on this device",
        cause = null,
      )

      if (isScanning) {
        promise.resolve(null)
        return
      }

      val scanSettingsBuilder = ScanSettings.Builder()
        .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        scanSettingsBuilder
          .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
          .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
      }

      activeScanner.startScan(null, scanSettingsBuilder.build(), scanCallback)
      isScanning = true
      promise.resolve(null)
    } catch (error: CodedException) {
      promise.reject(error.code, error.message, error)
    }
  }

  private fun stopScan() {
    if (isScanning) {
      // Throws IllegalStateException when the adapter is already off.
      runCatching { scanner?.stopScan(scanCallback) }
      isScanning = false
    }

    disconnectAllMeshPeers()
  }

  private fun handleScanResult(result: ScanResult) {
    val record = result.scanRecord ?: return
    if (!isMeshAdvertisement(record)) {
      return
    }

    scheduleMeshConnection(result, meshIdFromScanRecord(record))
  }

  private fun scheduleMeshConnection(result: ScanResult, meshId: String?) {
    val device = result.device
    val deviceId = device.address
    val localAdapterAddress = bluetoothAdapter?.address

    if (localAdapterAddress != null && deviceId.equals(localAdapterAddress, ignoreCase = true)) {
      return
    }

    if (meshId != null && meshId == localMeshId) {
      return
    }

    val existingPeer = meshPeers[deviceId]
    if (existingPeer != null) {
      // Learned the ID after connecting (it came with a later scan response): report it.
      if (existingPeer.meshId == null && meshId != null) {
        existingPeer.meshId = meshId
        if (existingPeer.isReady) {
          emitPeerConnected(existingPeer.deviceId, meshId, existingPeer.deviceName, existingPeer.rssi)
        }
      }
      return
    }

    if (pendingConnectionDeviceIds.contains(deviceId)) {
      return
    }

    // Addresses rotate, so one device can show up under several addresses. One link per device is
    // enough; the duplicate would only waste one of the peer slots.
    if (meshId != null && meshPeers.values.any { peer -> peer.meshId == meshId }) {
      return
    }

    if (meshPeers.size >= MAX_MESH_PEERS) {
      return
    }

    val now = System.currentTimeMillis()
    val lastAttempt = lastConnectionAttemptByDevice[deviceId] ?: 0L
    if (now - lastAttempt < CONNECTION_RETRY_INTERVAL_MS) {
      return
    }

    lastConnectionAttemptByDevice[deviceId] = now
    pendingConnectionDeviceIds.add(deviceId)

    val gattClient = device.connectGatt(context, false, meshClientCallback, BluetoothDevice.TRANSPORT_LE)
    if (gattClient == null) {
      pendingConnectionDeviceIds.remove(deviceId)
      return
    }

    meshPeers[deviceId] = MeshPeer(
      deviceId = deviceId,
      gatt = gattClient,
      meshId = meshId,
      deviceName = result.device.name,
      rssi = result.rssi,
      meshCharacteristic = null,
      isReady = false,
    )
    pendingConnectionDeviceIds.remove(deviceId)
    meshLog(
      tag = "gattClient",
      message = "Scheduled mesh connection",
      detail = mapOf(
        "deviceId" to deviceId,
        "meshId" to meshId,
        "deviceName" to result.device.name,
        "rssi" to result.rssi,
      ),
    )
  }

  /**
   * Discovers the mesh service. `discoverServices` returns false while another GATT operation
   * is in flight, and a started discovery can still get no answer: both are retried, up to
   * `MAX_DISCOVERY_ATTEMPTS`, then `watchLinkSetup` drops the link.
   */
  private fun discoverMeshServices(gatt: BluetoothGatt) {
    val peer = meshPeers[gatt.device.address] ?: return
    if (peer.gatt !== gatt || peer.isReady || peer.isDiscovering) {
      return
    }
    if (peer.discoveryAttempts >= MAX_DISCOVERY_ATTEMPTS) {
      return
    }

    peer.discoveryAttempts += 1
    val attempt = peer.discoveryAttempts
    val started = gatt.discoverServices()
    meshLog(
      tag = "gattClient",
      message = "Discovering services",
      detail = mapOf(
        "deviceId" to gatt.device.address,
        "attempt" to attempt,
        "started" to started,
      ),
      level = if (started) "info" else "warn",
    )
    if (!started) {
      mainHandler.postDelayed({ discoverMeshServices(gatt) }, DISCOVERY_RETRY_DELAY_MS)
      return
    }

    peer.isDiscovering = true
    mainHandler.postDelayed({
      val currentPeer = meshPeers[gatt.device.address] ?: return@postDelayed
      if (currentPeer.gatt !== gatt || currentPeer.isReady || !currentPeer.isDiscovering ||
        currentPeer.discoveryAttempts != attempt
      ) {
        return@postDelayed
      }
      meshLog(
        tag = "gattClient",
        message = "Service discovery got no answer",
        detail = mapOf("deviceId" to gatt.device.address, "attempt" to attempt),
        level = "warn",
      )
      currentPeer.isDiscovering = false
      discoverMeshServices(gatt)
    }, DISCOVERY_ANSWER_TIMEOUT_MS)
  }

  /** `BluetoothGatt.refresh()` is hidden but widely used: it drops the cached GATT table. */
  private fun refreshGattCache(gatt: BluetoothGatt): Boolean =
    try {
      gatt.javaClass.getMethod("refresh").invoke(gatt) as? Boolean ?: false
    } catch (error: Exception) {
      meshLog(
        tag = "gattClient",
        message = "Could not refresh the GATT cache",
        detail = mapOf("deviceId" to gatt.device.address, "error" to error.toString()),
        level = "warn",
      )
      false
    }

  /** Drops a connection that is still not ready after `LINK_SETUP_TIMEOUT_MS`, so it is retried. */
  private fun watchLinkSetup(gatt: BluetoothGatt) {
    mainHandler.postDelayed({
      val peer = meshPeers[gatt.device.address] ?: return@postDelayed
      if (peer.gatt !== gatt || peer.isReady) {
        return@postDelayed
      }
      dropMeshPeer(
        peer.deviceId,
        "Link not ready in time",
        mapOf("isDiscovering" to peer.isDiscovering, "timeoutMs" to LINK_SETUP_TIMEOUT_MS),
      )
    }, LINK_SETUP_TIMEOUT_MS)
  }

  /** Disconnects a broken link; the next advertisement from the peer connects it again. */
  private fun dropMeshPeer(deviceId: String, reason: String, detail: Map<String, Any?>) {
    val peer = meshPeers[deviceId] ?: return
    meshLog(
      tag = "gattClient",
      message = "Dropping link to reconnect: $reason",
      detail = detail + mapOf("deviceId" to deviceId, "wasReady" to peer.isReady),
      level = "warn",
    )
    peer.gatt.disconnect()
    cleanupMeshPeer(deviceId, emitDisconnect = true)
  }

  private fun cleanupMeshPeer(deviceId: String, emitDisconnect: Boolean) {
    if (activeSendOperation != null) {
      failActiveSendOperation(
        CodedException(
          code = "ERR_BLE_DISCONNECTED",
          message = "Peer disconnected during outbound write",
          cause = null,
        ),
      )
    }

    val peer = meshPeers.remove(deviceId) ?: return
    pendingConnectionDeviceIds.remove(deviceId)
    preparedWriteBuffers.remove(deviceId)
    peer.gatt.close()
    if (emitDisconnect) {
      emitPeerDisconnected(deviceId, peer.meshId)
    }
  }

  private fun disconnectAllMeshPeers() {
    for (deviceId in meshPeers.keys.toList()) {
      cleanupMeshPeer(deviceId, emitDisconnect = true)
    }
    pendingConnectionDeviceIds.clear()
  }

  private fun emitPeerConnected(deviceId: String, meshId: String?, deviceName: String?, rssi: Int) {
    sendEvent(
      "onPeerConnected",
      mapOf(
        "deviceId" to deviceId,
        "meshId" to meshId,
        "deviceName" to deviceName,
        "rssi" to rssi,
      ),
    )
  }

  private fun emitPeerDisconnected(deviceId: String, meshId: String?) {
    sendEvent(
      "onPeerDisconnected",
      mapOf(
        "deviceId" to deviceId,
        "meshId" to meshId,
      ),
    )
  }

  private fun emitMessage(
    linkDeviceId: String,
    deviceName: String?,
    rssi: Int,
    jsonMessage: String,
    source: String,
  ) {
    if (jsonMessage.isEmpty()) {
      return
    }

    val dedupeKey = "$linkDeviceId:$jsonMessage"
    if (lastEmittedJsonByLink[dedupeKey] == jsonMessage) {
      meshLog(
        tag = "receive",
        message = "Dropped duplicate payload on link",
        detail = mapOf(
          "linkDeviceId" to linkDeviceId,
          "wireChars" to jsonMessage.length,
        ),
        level = "debug",
      )
      return
    }

    lastEmittedJsonByLink[dedupeKey] = jsonMessage

    meshLog(
      tag = "receive",
      message = "Emitting packet to JS",
      detail = mapOf(
        "linkDeviceId" to linkDeviceId,
        "source" to source,
        "wireChars" to jsonMessage.length,
        "deviceName" to deviceName,
      ),
    )

    sendEvent(
      "onMessageReceived",
      mapOf(
        "deviceId" to linkDeviceId,
        "viaDeviceId" to linkDeviceId,
        "deviceName" to deviceName,
        "jsonMessage" to jsonMessage,
        "rssi" to rssi,
        "truncated" to false,
        "source" to source,
        "timestamp" to System.currentTimeMillis(),
      ),
    )
  }

  private fun isMeshAdvertisement(record: android.bluetooth.le.ScanRecord): Boolean {
    val localName = record.deviceName
    if (localName != null && localName.startsWith(LOCAL_NAME_PREFIX)) {
      return true
    }

    val serviceData = record.getServiceData(ParcelUuid(serviceUuid))
    if (serviceData != null) {
      return true
    }

    val advertisedServiceUuids = record.serviceUuids
    if (advertisedServiceUuids != null) {
      for (advertisedServiceUuid in advertisedServiceUuids) {
        if (matchesMeshServiceUuid(advertisedServiceUuid)) {
          return true
        }
      }
    }

    return false
  }

  private fun matchesMeshServiceUuid(advertisedServiceUuid: ParcelUuid): Boolean {
    return advertisedServiceUuid.uuid == serviceUuid ||
      advertisedServiceUuid.uuid.toString().startsWith("0000feed", ignoreCase = true)
  }

  private fun setupGattServer() {
    gattServer?.close()

    val manager = bluetoothManager ?: throw CodedException(
      code = "ERR_BLE_MANAGER",
      message = "Bluetooth manager unavailable",
      cause = null,
    )
    gattServer = manager.openGattServer(context, gattServerCallback)

    val characteristic = BluetoothGattCharacteristic(
      characteristicUuid,
      BluetoothGattCharacteristic.PROPERTY_READ or
        BluetoothGattCharacteristic.PROPERTY_WRITE or
        BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
      BluetoothGattCharacteristic.PERMISSION_READ or
        BluetoothGattCharacteristic.PERMISSION_WRITE,
    )
    characteristic.value = ByteArray(0)
    payloadCharacteristic = characteristic

    val service = BluetoothGattService(serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    service.addCharacteristic(characteristic)

    val added = gattServer?.addService(service) ?: false
    if (!added) {
      throw CodedException(
        code = "ERR_BLE_GATT",
        message = "Failed to register BLE GATT service",
        cause = null,
      )
    }
  }

  private fun accumulatePreparedWrite(deviceId: String, offset: Int, chunk: ByteArray): ByteArray {
    val requiredSize = offset + chunk.size
    val existing = preparedWriteBuffers[deviceId]
    val buffer = when {
      existing == null -> ByteArray(requiredSize)
      existing.size < requiredSize -> existing.copyOf(requiredSize)
      else -> existing
    }
    chunk.copyInto(buffer, destinationOffset = offset)
    preparedWriteBuffers[deviceId] = buffer
    return buffer
  }

  private fun queueAssembledWriteEmit(
    device: BluetoothDevice,
    characteristic: BluetoothGattCharacteristic,
    payload: ByteArray,
    source: String,
  ) {
    mainHandler.post {
      emitAssembledWrite(
        device = device,
        characteristic = characteristic,
        payload = payload,
        source = source,
      )
    }
  }

  private fun emitAssembledWrite(
    device: BluetoothDevice,
    characteristic: BluetoothGattCharacteristic,
    payload: ByteArray,
    source: String,
  ) {
    characteristic.value = payload

    val jsonMessage = Base64.encodeToString(payload, Base64.NO_WRAP)
    if (jsonMessage.isEmpty()) {
      return
    }

    meshLog(
      tag = "gattServer",
      message = "Received complete write on mesh characteristic",
      detail = mapOf(
        "deviceId" to device.address,
        "payloadBytes" to payload.size,
        "wireChars" to jsonMessage.length,
        "source" to source,
      ),
    )
    emitMessage(
      linkDeviceId = device.address,
      deviceName = device.name,
      rssi = meshPeers[device.address]?.rssi ?: 0,
      jsonMessage = jsonMessage,
      source = "connection",
    )
  }

  private fun buildResult(payload: ByteArray): Map<String, Any> {
    return mapOf(
      "totalBytes" to payload.size,
      "advertisedBytes" to 0,
      "truncated" to false,
    )
  }

  companion object {
    private const val SERVICE_UUID = "0000feed-0000-1000-8000-00805f9b34fb"
    private const val CHARACTERISTIC_UUID = "0000beef-0000-1000-8000-00805f9b34fb"
    private const val MAX_GATT_PAYLOAD_BYTES = 4096
    private const val MAX_GATT_READ_CHUNK_BYTES = 512
    /** ATT payload limit after MTU 517 negotiation (517 − 3 byte header). */
    private const val MAX_ATT_WRITE_BYTES = 512
    private const val MTU_SETTLE_DELAY_MS = 50L
    private const val MTU_WAIT_MS = 2_000L
    private const val DISCOVERY_RETRY_DELAY_MS = 500L
    private const val DISCOVERY_ANSWER_TIMEOUT_MS = 3_000L
    private const val MAX_DISCOVERY_ATTEMPTS = 4
    private const val LINK_SETUP_TIMEOUT_MS = 15_000L
    private const val MAX_CONSECUTIVE_WRITE_FAILURES = 3
    /** ATT "Invalid Handle": the characteristic is not where the cached GATT table says. */
    private const val ATT_INVALID_HANDLE = 1
    private const val LOCAL_NAME_PREFIX = "SM:"
    private const val CONNECTION_RETRY_INTERVAL_MS = 2000L
    private const val MAX_MESH_PEERS = 8
    private const val BLUETOOTH_STATE_POWERED_ON = "poweredOn"
    private const val BLUETOOTH_STATE_POWERED_OFF = "poweredOff"
    private const val BLUETOOTH_STATE_UNAUTHORIZED = "unauthorized"
    private const val BLUETOOTH_STATE_UNSUPPORTED = "unsupported"
    private const val BLUETOOTH_STATE_UNKNOWN = "unknown"
    private const val MESH_ID_FILE_NAME = "expo-mesh-device-id"
    private const val ITEMS_DIRECTORY_NAME = "expo-mesh-items"
    private const val ITEMS_FILE_SUFFIX = ".jsonl"
    private const val HEX_DIGITS = "0123456789abcdef"
  }
}
