import asyncio
import time

from bleak import BleakScanner


# Only these three registered phones will be monitored.
TARGET_PHONES = {
    "galaxy f16 5g": {
        "name": "Samsung Galaxy F16",
        "advertised_name": "Galaxy F16 5G",
    },
    "vismaya's m05": {
        "name": "Samsung Galaxy M05",
        "advertised_name": "Vismaya's M05",
    },
    "nothing phone (3a)": {
        "name": "Nothing Phone 3a",
        "advertised_name": "Nothing Phone (3a)",
    },
}

OFFLINE_AFTER_SECONDS = 20

_phone_status = {
    key: {
        "name": details["name"],
        "advertised_name": details["advertised_name"],
        "rssi": None,
        "status": "Offline",
        "last_seen": None,
    }
    for key, details in TARGET_PHONES.items()
}

_scanner = None
_is_running = False


def _detection_callback(device, advertisement_data):
    """Update the status of a registered phone when detected."""

    advertised_name = (
        device.name or advertisement_data.local_name or ""
    ).strip().casefold()

    if advertised_name not in TARGET_PHONES:
        return

    phone = _phone_status[advertised_name]

    phone["rssi"] = advertisement_data.rssi
    phone["last_seen"] = time.time()
    phone["status"] = "Online"


async def start_ble_monitor():
    """Start continuous Bluetooth scanning."""

    global _scanner, _is_running

    if _is_running:
        return

    _scanner = BleakScanner(
        detection_callback=_detection_callback
    )

    await _scanner.start()
    _is_running = True

    print("ARCHNOVA BLE Monitor started.")
    print("Monitoring the 3 registered phones only.")


async def stop_ble_monitor():
    """Stop Bluetooth scanning."""

    global _scanner, _is_running

    if _scanner is not None and _is_running:
        await _scanner.stop()

    _scanner = None
    _is_running = False

    print("ARCHNOVA BLE Monitor stopped.")


def get_ble_status():
    """Return the latest RSSI and online/offline status."""

    current_time = time.time()
    result = []

    for phone in _phone_status.values():
        last_seen = phone["last_seen"]

        if (
            last_seen is None
            or current_time - last_seen > OFFLINE_AFTER_SECONDS
        ):
            status = "Offline"
        else:
            status = "Online"

        result.append({
            "name": phone["name"],
            "advertised_name": phone["advertised_name"],
            "rssi": phone["rssi"],
            "status": status,
            "last_seen": last_seen,
        })

    return {
        "monitoring": _is_running,
        "total_phones": len(result),
        "phones": result,
    }