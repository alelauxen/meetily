//! Junta trechos de fala curtos antes da transcrição ao vivo (versão personalizada).
//!
//! O VAD do ao vivo fecha um trecho a cada pausa de ~0,5 s, então frases curtas viram
//! pedaços de 1–2 s. Com tão pouco áudio, o Parakeet às vezes "adivinha" inglês e o
//! Whisper inventa frases. Aqui os trechos curtos esperam um pouco e são unidos com os
//! seguintes, até formar um trecho de pelo menos `TARGET_MS` ou até a pessoa ficar em
//! silêncio por `MAX_WAIT_MS`. Trechos que já são longos seguem direto.

/// Trecho pronto para transcrever (amostras a 16 kHz, tempos em ms da sessão).
#[derive(Debug, Clone)]
pub struct MergedSegment {
    pub samples: Vec<f32>,
    pub start_ms: f64,
    pub end_ms: f64,
}

/// Duração mínima desejada de um trecho enviado ao modelo.
pub const TARGET_MS: f64 = 4000.0;
/// Tempo máximo esperando o próximo trecho antes de enviar o que já tem.
pub const MAX_WAIT_MS: f64 = 1500.0;
/// Pausa máxima entre dois trechos para ainda juntá-los.
pub const MAX_GAP_MS: f64 = 2000.0;
/// Tamanho máximo de um trecho unido.
pub const MAX_MERGED_MS: f64 = 20000.0;
/// Silêncio inserido entre trechos unidos (no máximo), para o modelo perceber a pausa.
const JOIN_SILENCE_MS: f64 = 250.0;
const SAMPLES_PER_MS: f64 = 16.0;

#[derive(Default)]
pub struct SegmentCoalescer {
    pending: Option<MergedSegment>,
}

impl SegmentCoalescer {
    pub fn new() -> Self {
        Self { pending: None }
    }

    fn duration(seg: &MergedSegment) -> f64 {
        seg.end_ms - seg.start_ms
    }

    /// Recebe um trecho do VAD e devolve os trechos que já devem ser transcritos.
    pub fn push(&mut self, samples: Vec<f32>, start_ms: f64, end_ms: f64) -> Vec<MergedSegment> {
        let mut out = Vec::new();
        let incoming = MergedSegment { samples, start_ms, end_ms };

        match self.pending.take() {
            Some(mut pending) => {
                let gap = (incoming.start_ms - pending.end_ms).max(0.0);
                let merged_len = incoming.end_ms - pending.start_ms;
                if gap <= MAX_GAP_MS && merged_len <= MAX_MERGED_MS {
                    let silence = (gap.min(JOIN_SILENCE_MS) * SAMPLES_PER_MS) as usize;
                    pending.samples.extend(std::iter::repeat(0.0).take(silence));
                    pending.samples.extend(incoming.samples);
                    pending.end_ms = incoming.end_ms;
                    self.pending = Some(pending);
                } else {
                    out.push(pending);
                    self.pending = Some(incoming);
                }
            }
            None => self.pending = Some(incoming),
        }

        if let Some(p) = &self.pending {
            if Self::duration(p) >= TARGET_MS {
                out.push(self.pending.take().unwrap());
            }
        }
        out
    }

    /// Chamado periodicamente com o tempo atual da sessão (ms): envia o trecho pendente
    /// se a pessoa ficou em silêncio tempo demais.
    pub fn tick(&mut self, now_ms: f64) -> Option<MergedSegment> {
        let should_flush = self
            .pending
            .as_ref()
            .map(|p| now_ms - p.end_ms >= MAX_WAIT_MS)
            .unwrap_or(false);
        if should_flush {
            self.pending.take()
        } else {
            None
        }
    }

    /// Envia o que sobrou (fim da gravação).
    pub fn flush(&mut self) -> Option<MergedSegment> {
        self.pending.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f64, end: f64) -> (Vec<f32>, f64, f64) {
        (vec![0.1; ((end - start) * SAMPLES_PER_MS) as usize], start, end)
    }

    #[test]
    fn long_segment_goes_straight_through() {
        let mut c = SegmentCoalescer::new();
        let (s, a, b) = seg(0.0, 5000.0);
        let out = c.push(s, a, b);
        assert_eq!(out.len(), 1);
        assert!(c.flush().is_none());
    }

    #[test]
    fn short_segments_are_joined_until_target() {
        let mut c = SegmentCoalescer::new();
        let (s, a, b) = seg(0.0, 1500.0);
        assert!(c.push(s, a, b).is_empty());
        let (s, a, b) = seg(2000.0, 3500.0);
        assert!(c.push(s, a, b).is_empty());
        let (s, a, b) = seg(3800.0, 5000.0);
        let out = c.push(s, a, b);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].start_ms, 0.0);
        assert_eq!(out[0].end_ms, 5000.0);
        // 1500+1500+1200 ms de fala + 250 + 250 ms de silêncio entre eles
        assert_eq!(out[0].samples.len(), ((4200.0 + 500.0) * SAMPLES_PER_MS) as usize);
    }

    #[test]
    fn short_segment_is_sent_after_silence() {
        let mut c = SegmentCoalescer::new();
        let (s, a, b) = seg(0.0, 1200.0);
        assert!(c.push(s, a, b).is_empty());
        assert!(c.tick(2000.0).is_none());
        let out = c.tick(2800.0).expect("deve enviar após silêncio");
        assert_eq!(out.end_ms, 1200.0);
    }

    #[test]
    fn far_apart_segments_are_not_joined() {
        let mut c = SegmentCoalescer::new();
        let (s, a, b) = seg(0.0, 1000.0);
        assert!(c.push(s, a, b).is_empty());
        let (s, a, b) = seg(5000.0, 6000.0);
        let out = c.push(s, a, b);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].end_ms, 1000.0);
        assert_eq!(c.flush().unwrap().start_ms, 5000.0);
    }
}
