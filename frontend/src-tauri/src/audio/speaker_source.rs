//! Identificação aproximada da origem da fala (versão personalizada).
//!
//! O Meetily capta o microfone e o áudio do computador separadamente e depois
//! mistura os dois antes da transcrição. Aqui guardamos a energia de cada fonte
//! por janela de mixagem e, quando o VAD entrega um trecho de fala, decidimos
//! qual fonte predominou nele:
//!
//! - `Local`  → microfone (o próprio usuário e quem está na mesma sala)
//! - `Remoto` → áudio do computador (participantes da chamada online)
//!
//! Se o áudio do computador nunca teve som na sessão (reunião presencial),
//! nenhum rótulo é aplicado.

use once_cell::sync::Lazy;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

/// Rótulos por `chunk_id` dos trechos enviados para transcrição.
static CHUNK_LABELS: Lazy<Mutex<HashMap<u64, &'static str>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// RMS mínimo (~ -40 dBFS) para considerar que a fonte tem som.
const ACTIVE_RMS: f32 = 0.01;
/// Quanto do histórico de energia manter (ms).
const HISTORY_MS: f64 = 180_000.0;

pub const LABEL_LOCAL: &str = "Local";
pub const LABEL_REMOTE: &str = "Remoto";

struct WindowEnergy {
    start_ms: f64,
    end_ms: f64,
    mic: f64,
    sys: f64,
}

/// Acompanha a energia do microfone e do sistema ao longo da gravação.
pub struct SourceTracker {
    sample_rate: f64,
    mixed_samples: u64,
    windows: VecDeque<WindowEnergy>,
    system_seen_active: bool,
    mic_seen_active: bool,
}

fn energy(samples: &[f32]) -> f64 {
    samples.iter().map(|&x| (x as f64) * (x as f64)).sum()
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (energy(samples) / samples.len() as f64).sqrt() as f32
}

impl SourceTracker {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate: sample_rate.max(1) as f64,
            mixed_samples: 0,
            windows: VecDeque::new(),
            system_seen_active: false,
            mic_seen_active: false,
        }
    }

    /// Tempo atual da sessão (ms), na mesma linha do tempo dos trechos do VAD.
    pub fn now_ms(&self) -> f64 {
        self.mixed_samples as f64 * 1000.0 / self.sample_rate
    }

    /// Registra uma janela de mixagem (mesma linha do tempo que o VAD recebe).
    pub fn record_window(&mut self, mic_window: &[f32], sys_window: &[f32]) {
        let len = mic_window.len().max(sys_window.len()) as u64;
        let start_ms = self.mixed_samples as f64 * 1000.0 / self.sample_rate;
        self.mixed_samples += len;
        let end_ms = self.mixed_samples as f64 * 1000.0 / self.sample_rate;

        if rms(sys_window) > ACTIVE_RMS {
            self.system_seen_active = true;
        }
        if rms(mic_window) > ACTIVE_RMS {
            self.mic_seen_active = true;
        }

        self.windows.push_back(WindowEnergy {
            start_ms,
            end_ms,
            mic: energy(mic_window),
            sys: energy(sys_window),
        });

        while let Some(front) = self.windows.front() {
            if end_ms - front.end_ms > HISTORY_MS {
                self.windows.pop_front();
            } else {
                break;
            }
        }
    }

    /// Decide a origem predominante de um trecho de fala (timestamps do VAD, em ms).
    pub fn classify(&self, start_ms: f64, end_ms: f64) -> Option<&'static str> {
        // Só faz sentido diferenciar quando as duas fontes tiveram som na sessão.
        if !self.system_seen_active || !self.mic_seen_active {
            return None;
        }
        let (mut mic, mut sys) = (0.0, 0.0);
        for w in self.windows.iter() {
            if w.end_ms <= start_ms || w.start_ms >= end_ms {
                continue;
            }
            mic += w.mic;
            sys += w.sys;
        }
        if mic == 0.0 && sys == 0.0 {
            return None;
        }
        Some(if sys > mic { LABEL_REMOTE } else { LABEL_LOCAL })
    }
}

/// Associa um rótulo ao trecho enviado para transcrição.
pub fn set_chunk_label(chunk_id: u64, label: &'static str) {
    if let Ok(mut map) = CHUNK_LABELS.lock() {
        map.insert(chunk_id, label);
    }
}

/// Retira o rótulo de um trecho (usado pelo transcritor).
pub fn take_chunk_label(chunk_id: u64) -> Option<&'static str> {
    CHUNK_LABELS.lock().ok().and_then(|mut map| map.remove(&chunk_id))
}

/// Limpa rótulos pendentes (início de nova gravação).
pub fn clear_labels() {
    if let Ok(mut map) = CHUNK_LABELS.lock() {
        map.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_label_without_system_audio() {
        let mut t = SourceTracker::new(16000);
        for _ in 0..20 {
            t.record_window(&vec![0.2; 800], &vec![0.0; 800]);
        }
        assert_eq!(t.classify(0.0, 1000.0), None);
    }

    #[test]
    fn labels_dominant_source() {
        let mut t = SourceTracker::new(16000);
        // 0–500 ms: microfone; 500–1000 ms: sistema
        for _ in 0..10 {
            t.record_window(&vec![0.2; 800], &vec![0.0; 800]);
        }
        for _ in 0..10 {
            t.record_window(&vec![0.01; 800], &vec![0.3; 800]);
        }
        assert_eq!(t.classify(0.0, 500.0), Some(LABEL_LOCAL));
        assert_eq!(t.classify(500.0, 1000.0), Some(LABEL_REMOTE));
    }

    #[test]
    fn chunk_label_roundtrip() {
        set_chunk_label(424242, LABEL_REMOTE);
        assert_eq!(take_chunk_label(424242), Some(LABEL_REMOTE));
        assert_eq!(take_chunk_label(424242), None);
    }
}
