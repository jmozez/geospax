//! The phone's barometer: one air pressure reading in hPa, through the NDK sensor API (no Java plugin).
//! `None` when the phone has no pressure sensor (many cheaper phones) or it gives no reading in time.

#[cfg(target_os = "android")]
pub fn read_hpa(timeout_ms: i32) -> Option<f64> {
    use ndk_sys::*;
    use std::ptr::null_mut;
    unsafe {
        let mgr = ASensorManager_getInstanceForPackage(c"io.github.jmozez.geospax.field".as_ptr());
        if mgr.is_null() {
            return None;
        }
        let sensor = ASensorManager_getDefaultSensor(mgr, ASENSOR_TYPE_PRESSURE as i32);
        if sensor.is_null() {
            return None;
        }
        let looper = ALooper_prepare(ALOOPER_PREPARE_ALLOW_NON_CALLBACKS as i32);
        let queue = ASensorManager_createEventQueue(mgr, looper, 1, None, null_mut());
        if queue.is_null() {
            return None;
        }
        let mut out = None;
        if ASensorEventQueue_enableSensor(queue, sensor) >= 0 {
            let start = std::time::Instant::now();
            'wait: while (start.elapsed().as_millis() as i32) < timeout_ms {
                let left = timeout_ms - start.elapsed().as_millis() as i32;
                ALooper_pollOnce(left.max(1), null_mut(), null_mut(), null_mut());
                let mut ev: ASensorEvent = std::mem::zeroed();
                while ASensorEventQueue_getEvents(queue, &mut ev, 1) > 0 {
                    let p = ev.__bindgen_anon_1.__bindgen_anon_1.pressure as f64;
                    // a plausible air pressure: 300 hPa (above 9,000 m) to 1,100 hPa
                    if (300.0..=1100.0).contains(&p) {
                        out = Some(p);
                        break 'wait;
                    }
                }
            }
            ASensorEventQueue_disableSensor(queue, sensor);
        }
        ASensorManager_destroyEventQueue(mgr, queue);
        out
    }
}

#[cfg(not(target_os = "android"))]
pub fn read_hpa(_timeout_ms: i32) -> Option<f64> {
    None
}

/// Air pressure now, in hPa, or null without a barometer.
#[tauri::command]
pub async fn barometer_hpa() -> Option<f64> {
    tauri::async_runtime::spawn_blocking(|| read_hpa(1500)).await.ok().flatten()
}
