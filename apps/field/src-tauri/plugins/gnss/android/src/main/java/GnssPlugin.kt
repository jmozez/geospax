// GeoSpaX Field: NMEA from a Bluetooth GNSS receiver. The web view has no Web Bluetooth on Android, so this
// lists paired and nearby receivers and connects to one over Bluetooth Classic (the serial port profile,
// as most survey and RTK receivers use) or Bluetooth LE (a Nordic UART or HM-10 serial service). The
// receiver's text goes to the web view as it arrives, in chunks; the NMEA parser there (gnss.ts) reads it.
package app.geospax.gnss

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothSocket
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.IOException
import java.util.UUID

private const val ALIAS = "bluetooth"
private val SPP: UUID = UUID.fromString("00001101-0000-1000-8000-00805f9b34fb")
private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
// serial services and the characteristic the receiver sends on: Nordic UART (TX notify) and HM-10
private val UARTS: List<Pair<UUID, UUID>> = listOf(
    UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e") to UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e"),
    UUID.fromString("0000ffe0-0000-1000-8000-00805f9b34fb") to UUID.fromString("0000ffe1-0000-1000-8000-00805f9b34fb"),
)

@InvokeArg
class DevicesArgs {
    /** how long to scan for BLE receivers that are not paired, milliseconds (0: paired ones only) */
    var scanMs: Long = 4000
}

@InvokeArg
class ConnectArgs {
    lateinit var address: String
    /** "spp" (Bluetooth Classic) or "ble" */
    var mode: String = "spp"
    lateinit var onData: Channel
}

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN], alias = ALIAS)])
class GnssPlugin(private val activity: Activity) : Plugin(activity) {
    private val main = Handler(Looper.getMainLooper())
    private var socket: BluetoothSocket? = null
    private var gatt: BluetoothGatt? = null
    private var channel: Channel? = null
    @Volatile private var closing = false

    private fun adapter(): BluetoothAdapter? =
        (activity.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager?)?.adapter

    // Android 11 and older grant Bluetooth at install
    private fun granted(): JSObject = JSObject().put(ALIAS, "granted")

    @Command
    override fun checkPermissions(invoke: Invoke) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) invoke.resolve(granted()) else super.checkPermissions(invoke)
    }

    @Command
    override fun requestPermissions(invoke: Invoke) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) invoke.resolve(granted()) else super.requestPermissions(invoke)
    }

    private fun kind(d: BluetoothDevice): String = when (d.type) {
        BluetoothDevice.DEVICE_TYPE_LE -> "ble"
        BluetoothDevice.DEVICE_TYPE_DUAL -> "dual"
        else -> "classic"
    }

    /** Paired receivers, then BLE ones found nearby: [{name, address, type, paired}]. */
    @SuppressLint("MissingPermission")
    @Command
    fun devices(invoke: Invoke) {
        val a = adapter()
        if (a == null) return invoke.reject("This phone has no Bluetooth.")
        if (!a.isEnabled) return invoke.reject("Bluetooth is off: turn it on in the phone settings.")
        val args = invoke.parseArgs(DevicesArgs::class.java)
        val found = LinkedHashMap<String, JSObject>()
        try {
            for (d in a.bondedDevices) found[d.address] = JSObject().put("name", d.name ?: d.address).put("address", d.address).put("type", kind(d)).put("paired", true)
        } catch (e: SecurityException) {
            return invoke.reject("Bluetooth is not allowed for GeoSpaX Field: allow Nearby devices in the phone settings.")
        }
        val scanner = a.bluetoothLeScanner
        if (args.scanMs <= 0 || scanner == null) return invoke.resolve(JSObject().put("devices", JSArray(found.values.toList())))
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, r: ScanResult) {
                val d = r.device
                if (found.containsKey(d.address)) return
                val name = try { d.name } catch (e: SecurityException) { null } ?: r.scanRecord?.deviceName ?: return
                found[d.address] = JSObject().put("name", name).put("address", d.address).put("type", "ble").put("paired", false)
            }
        }
        try { scanner.startScan(cb) } catch (e: SecurityException) { return invoke.resolve(JSObject().put("devices", JSArray(found.values.toList()))) }
        main.postDelayed({
            try { scanner.stopScan(cb) } catch (_: Exception) {}
            invoke.resolve(JSObject().put("devices", JSArray(found.values.toList())))
        }, args.scanMs.coerceAtMost(15000))
    }

    private fun send(text: String) { channel?.send(JSObject().put("text", text)) }
    private fun closed(error: String?) {
        val c = channel ?: return
        channel = null
        c.send(JSObject().put("closed", true).put("error", error))
    }

    @SuppressLint("MissingPermission")
    @Command
    fun connect(invoke: Invoke) {
        val args = invoke.parseArgs(ConnectArgs::class.java)
        val a = adapter() ?: return invoke.reject("This phone has no Bluetooth.")
        val d = try { a.getRemoteDevice(args.address) } catch (e: IllegalArgumentException) { return invoke.reject("Not a Bluetooth address: ${args.address}") }
        stop()
        closing = false
        channel = args.onData
        if (args.mode == "ble") connectBle(d, invoke) else connectSpp(a, d, invoke)
    }

    // Bluetooth Classic: an RFCOMM socket to the serial port service, read on its own thread
    @SuppressLint("MissingPermission")
    private fun connectSpp(a: BluetoothAdapter, d: BluetoothDevice, invoke: Invoke) {
        Thread {
            try {
                try { a.cancelDiscovery() } catch (_: SecurityException) {}
                val s = try { d.createRfcommSocketToServiceRecord(SPP).also { it.connect() } }
                    catch (e: IOException) { d.createInsecureRfcommSocketToServiceRecord(SPP).also { it.connect() } }
                socket = s
                invoke.resolve(JSObject().put("name", d.name ?: d.address))
                val buf = ByteArray(1024)
                val input = s.inputStream
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    if (n > 0) send(String(buf, 0, n, Charsets.ISO_8859_1))
                }
                closed(null)
            } catch (e: SecurityException) {
                invoke.reject("Bluetooth is not allowed for GeoSpaX Field: allow Nearby devices in the phone settings.")
                channel = null
            } catch (e: IOException) {
                if (socket == null) { channel = null; invoke.reject("Could not connect to ${try { d.name } catch (_: SecurityException) { null } ?: d.address}: is it on, paired and not used by another app?") }
                else closed(if (closing) null else "The connection was lost")
            } finally {
                try { socket?.close() } catch (_: IOException) {}
                socket = null
            }
        }.start()
    }

    // Bluetooth LE: subscribe to the serial service's notifications
    @SuppressLint("MissingPermission")
    private fun connectBle(d: BluetoothDevice, invoke: Invoke) {
        var answered = false
        fun fail(msg: String) { if (!answered) { answered = true; channel = null; invoke.reject(msg) } else closed(msg) }
        val cb = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(g: BluetoothGatt, status: Int, state: Int) {
                if (state == BluetoothProfile.STATE_CONNECTED) { g.requestMtu(247) }
                else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                    g.close(); if (gatt === g) gatt = null
                    if (closing) closed(null) else fail(if (answered) "The connection was lost" else "Could not connect to ${d.address}")
                }
            }
            override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) { g.discoverServices() }
            override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                val ch = UARTS.firstNotNullOfOrNull { (s, c) -> g.getService(s)?.getCharacteristic(c) }
                if (ch == null) { fail("This receiver has no Bluetooth LE serial service (Nordic UART or HM-10): try Bluetooth Classic"); g.disconnect(); return }
                g.setCharacteristicNotification(ch, true)
                val desc = ch.getDescriptor(CCCD)
                if (desc != null) {
                    if (Build.VERSION.SDK_INT >= 33) g.writeDescriptor(desc, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                    else @Suppress("DEPRECATION") run { desc.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE; g.writeDescriptor(desc) }
                }
                if (!answered) { answered = true; invoke.resolve(JSObject().put("name", d.name ?: d.address)) }
            }
            override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic, value: ByteArray) {
                send(String(value, Charsets.ISO_8859_1))
            }
            @Deprecated("Android 12 and older")
            override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic) {
                if (Build.VERSION.SDK_INT < 33) @Suppress("DEPRECATION") send(String(ch.value ?: return, Charsets.ISO_8859_1))
            }
        }
        try { gatt = d.connectGatt(activity, false, cb, BluetoothDevice.TRANSPORT_LE) }
        catch (e: SecurityException) { fail("Bluetooth is not allowed for GeoSpaX Field: allow Nearby devices in the phone settings.") }
    }

    @SuppressLint("MissingPermission")
    private fun stop() {
        closing = true
        try { socket?.close() } catch (_: IOException) {}
        try { gatt?.disconnect() } catch (_: SecurityException) {}
    }

    @Command
    fun disconnect(invoke: Invoke) {
        stop()
        invoke.resolve()
    }

    override fun onDestroy() { stop(); super.onDestroy() }
}
