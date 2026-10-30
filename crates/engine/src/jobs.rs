//! Background job registry (seed of the geoprocessing job engine).
//!
//! Jobs run on a dedicated rayon pool, separate from the interactive tile
//! pool, report progress through a shared state and stop cooperatively when
//! their cancel flag is set. The UI polls `GET /api/jobs/{id}`.

use serde::Serialize;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone)]
pub struct JobState {
    pub status: Status,
    pub done: u64,
    pub total: u64,
    pub message: String,
    pub result: Option<Value>,
    pub finished_ms: Option<f64>,
    /** what the job printed, newest last (R setup shows it like QGIS's plugin manager log) */
    pub log: Vec<String>,
    /** a download in progress: label, bytes so far, estimated total, rate, ETA (the online-data gauge) */
    pub transfer: Option<Value>,
}

pub struct Job {
    pub id: u64,
    pub kind: &'static str,
    pub layer: String,
    pub cancel: AtomicBool,
    started: Instant,
    state: Mutex<JobState>,
}

impl Job {
    /// Add a line to the job's log (the last 400 lines are kept).
    pub fn log(&self, line: impl Into<String>) {
        let mut s = self.state.lock().unwrap();
        s.log.push(line.into());
        if s.log.len() > 400 {
            let n = s.log.len() - 400;
            s.log.drain(..n);
        }
    }

    pub fn update(&self, f: impl FnOnce(&mut JobState)) {
        f(&mut self.state.lock().unwrap());
    }

    pub fn status(&self) -> Status {
        self.state.lock().unwrap().status
    }

    pub fn is_active(&self) -> bool {
        matches!(self.status(), Status::Queued | Status::Running)
    }

    /// Final transition; records the wall time.
    pub fn finish(&self, status: Status, message: String, result: Option<Value>) {
        let ms = self.started.elapsed().as_secs_f64() * 1000.0;
        self.update(|s| {
            s.status = status;
            s.message = message;
            s.result = result;
            s.finished_ms = Some(ms);
        });
    }

    pub fn json(&self) -> Value {
        let s = self.state.lock().unwrap().clone();
        let elapsed = s
            .finished_ms
            .unwrap_or_else(|| self.started.elapsed().as_secs_f64() * 1000.0);
        json!({
            "id": self.id,
            "kind": self.kind,
            "layer": self.layer,
            "status": s.status,
            "done": s.done,
            "total": s.total,
            "progress": if s.total > 0 { s.done as f64 / s.total as f64 } else { 0.0 },
            "message": s.message,
            "elapsed_ms": elapsed,
            "result": s.result,
            "log": s.log,
            "transfer": s.transfer,
        })
    }
}

#[derive(Default)]
pub struct Jobs {
    next: AtomicU64,
    list: Mutex<Vec<Arc<Job>>>,
}

impl Jobs {
    pub fn create(&self, kind: &'static str, layer: &str) -> Arc<Job> {
        let job = Arc::new(Job {
            id: self.next.fetch_add(1, Ordering::Relaxed) + 1,
            kind,
            layer: layer.to_string(),
            cancel: AtomicBool::new(false),
            started: Instant::now(),
            state: Mutex::new(JobState {
                status: Status::Queued,
                done: 0,
                total: 0,
                message: String::new(),
                result: None,
                finished_ms: None,
                log: Vec::new(),
                transfer: None,
            }),
        });
        let mut list = self.list.lock().unwrap();
        // keep the registry bounded: forget the oldest finished jobs
        while list.len() >= 100 {
            match list.iter().position(|j| !j.is_active()) {
                Some(i) => {
                    list.remove(i);
                }
                None => break,
            }
        }
        list.push(job.clone());
        job
    }

    pub fn get(&self, id: u64) -> Option<Arc<Job>> {
        self.list
            .lock()
            .unwrap()
            .iter()
            .find(|j| j.id == id)
            .cloned()
    }

    pub fn active(&self, kind: &str, layer: &str) -> Option<Arc<Job>> {
        self.list
            .lock()
            .unwrap()
            .iter()
            .find(|j| j.kind == kind && j.layer == layer && j.is_active())
            .cloned()
    }

    pub fn json(&self) -> Value {
        let list = self.list.lock().unwrap();
        Value::Array(list.iter().rev().map(|j| j.json()).collect())
    }
}
