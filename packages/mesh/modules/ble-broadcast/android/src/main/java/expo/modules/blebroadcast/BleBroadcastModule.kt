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
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import org.json.JSONObject
import expo.modules.kotlin.exception.CodedException
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
    var deviceName: String?,
    var rssi: Int,
    var meshCharacteristic: BluetoothGattCharacteristic?,
    var isReady: Boolean = false,
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
        // Disconnect is handled from the GATT client peer lifecycle.
      }
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
      val server = gattServer ?: return
      val chunk = value ?: ByteArray(0)
      val deviceId = device.address

      if (preparedWrite) {
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
          gatt.requestMtu(517)
          // iOS peripherals often never fire onMtuChanged — do not gate discovery on it.
          mainHandler.postDelayed({
            val connectedPeer = meshPeers[gatt.device.address] ?: return@postDelayed
            if (!connectedPeer.isReady) {
              meshLog(
                tag = "gattClient",
                message = "Discovering services after connect",
                detail = mapOf("deviceId" to gatt.device.address),
              )
              gatt.discoverServices()
            }
          }, MTU_SETTLE_DELAY_MS)
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
      val connectedPeer = meshPeers[gatt.device.address] ?: return
      if (connectedPeer.isReady) {
        return
      }
      mainHandler.postDelayed({
        if (meshPeers[gatt.device.address]?.isReady != true) {
          gatt.discoverServices()
        }
      }, MTU_SETTLE_DELAY_MS)
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      val peer = meshPeers[gatt.device.address] ?: return

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
        gatt.disconnect()
        return
      }

      peer.meshCharacteristic = characteristic
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
        ),
      )
      emitPeerConnected(peer.deviceId, peer.deviceName, peer.rssi)
    }

    override fun onCharacteristicWrite(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int,
    ) {
      if (status != BluetoothGatt.GATT_SUCCESS) {
        meshLog(
          tag = "gattClient",
          message = "Outbound write failed",
          detail = mapOf(
            "deviceId" to gatt.device.address,
            "status" to status,
            "payloadBytes" to (characteristic.value?.size ?: 0),
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
        return
      }

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

    Events("onMessageReceived", "onPeerConnected", "onPeerDisconnected", "onMeshLog")

    AsyncFunction("startBroadcastAsync") { _jsonMessage: String, promise: Promise ->
      startMeshPeripheral(promise)
    }

    AsyncFunction("stopBroadcastAsync") {
      stopMeshPeripheral()
    }

    AsyncFunction("updateBroadcastAsync") { _jsonMessage: String, promise: Promise ->
      promise.resolve(buildResult(ByteArray(0)))
    }

    AsyncFunction("isBroadcastingAsync") {
      isAdvertising
    }

    AsyncFunction("startScanAsync") { promise: Promise ->
      startScan(promise)
    }

    AsyncFunction("stopScanAsync") {
      stopScan()
    }

    AsyncFunction("isScanningAsync") {
      isScanning
    }

    AsyncFunction("sendPacketAsync") { jsonMessage: String, excludeDeviceId: String?, promise: Promise ->
      sendPacket(jsonMessage, excludeDeviceId, promise)
    }

    AsyncFunction("getConnectedPeerCountAsync") {
      meshPeers.values.count { peer -> peer.isReady }
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

      val advertiseData = AdvertiseData.Builder()
        .setIncludeDeviceName(false)
        .addServiceUuid(ParcelUuid(serviceUuid))
        .build()

      val settings = AdvertiseSettings.Builder()
        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
        .setConnectable(true)
        .build()

      pendingStartPromise = promise
      advertiser?.startAdvertising(settings, advertiseData, advertiseCallback)
    } catch (error: CodedException) {
      promise.reject(error.code, error.message, error)
    }
  }

  private fun stopMeshPeripheral() {
    if (isAdvertising) {
      advertiser?.stopAdvertising(advertiseCallback)
      isAdvertising = false
    }

    gattServer?.close()
    gattServer = null
    payloadCharacteristic = null
    pendingStartPromise?.reject("ERR_BLE_STOPPED", "Mesh peripheral stopped", null)
    pendingStartPromise = null
  }

  private fun sendPacket(jsonMessage: String, excludeDeviceId: String?, promise: Promise) {
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
      scanner?.stopScan(scanCallback)
      isScanning = false
    }

    disconnectAllMeshPeers()
  }

  private fun handleScanResult(result: ScanResult) {
    val record = result.scanRecord ?: return
    if (!isMeshAdvertisement(record)) {
      return
    }

    scheduleMeshConnection(result)
  }

  private fun scheduleMeshConnection(result: ScanResult) {
    val device = result.device
    val deviceId = device.address
    val localAdapterAddress = bluetoothAdapter?.address

    if (localAdapterAddress != null && deviceId.equals(localAdapterAddress, ignoreCase = true)) {
      return
    }

    if (meshPeers.containsKey(deviceId) || pendingConnectionDeviceIds.contains(deviceId)) {
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
        "deviceName" to result.device.name,
        "rssi" to result.rssi,
      ),
    )
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
      emitPeerDisconnected(deviceId)
    }
  }

  private fun disconnectAllMeshPeers() {
    for (deviceId in meshPeers.keys.toList()) {
      cleanupMeshPeer(deviceId, emitDisconnect = true)
    }
    pendingConnectionDeviceIds.clear()
  }

  private fun emitPeerConnected(deviceId: String, deviceName: String?, rssi: Int) {
    sendEvent(
      "onPeerConnected",
      mapOf(
        "deviceId" to deviceId,
        "deviceName" to deviceName,
        "rssi" to rssi,
      ),
    )
  }

  private fun emitPeerDisconnected(deviceId: String) {
    sendEvent(
      "onPeerDisconnected",
      mapOf(
        "deviceId" to deviceId,
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
    private const val LOCAL_NAME_PREFIX = "SM:"
    private const val CONNECTION_RETRY_INTERVAL_MS = 2000L
    private const val MAX_MESH_PEERS = 8
  }
}
