//! Reconnect waits: exponential, capped, with jitter so a server restart isn't hit by every
//! app at the same instant.

use std::time::Duration;

/// Exponential backoff with full jitter in the upper half.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backoff {
    /// First wait.
    pub base: Duration,
    /// Longest wait.
    pub max: Duration,
    attempt: u32,
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new(Duration::from_millis(500), Duration::from_secs(10))
    }
}

impl Backoff {
    /// Starting at `base`, doubling up to `max`.
    #[must_use]
    pub const fn new(base: Duration, max: Duration) -> Self {
        Self {
            base,
            max,
            attempt: 0,
        }
    }

    /// The next wait. `jitter` is a random number in `0..1`; the wait is between half and all
    /// of the step (so it never collapses to zero).
    pub fn next_wait(&mut self, jitter: f64) -> Duration {
        let step = self.base.saturating_mul(1 << self.attempt.min(16)).min(self.max);
        self.attempt = self.attempt.saturating_add(1);
        step.mul_f64(0.5 + jitter.clamp(0.0, 1.0) / 2.0)
    }

    /// Connected: start over.
    pub const fn reset(&mut self) {
        self.attempt = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubles_caps_and_resets() {
        let mut b = Backoff::new(Duration::from_millis(100), Duration::from_millis(1000));
        let waits: Vec<_> = (0..6).map(|_| b.next_wait(1.0).as_millis()).collect();
        assert_eq!(waits, vec![100, 200, 400, 800, 1000, 1000]);
        b.reset();
        assert_eq!(b.next_wait(1.0).as_millis(), 100);
    }

    #[test]
    fn jitter_keeps_at_least_half() {
        let mut b = Backoff::new(Duration::from_millis(100), Duration::from_secs(1));
        assert_eq!(b.next_wait(0.0).as_millis(), 50);
        assert_eq!(
            b.next_wait(7.0).as_millis(),
            200,
            "out-of-range jitter is clamped"
        );
    }
}
