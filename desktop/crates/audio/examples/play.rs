//! Plays the test sound through the pipeline's speakers for a second (checks the render side).
#![allow(clippy::print_stdout, missing_docs)]

struct NoEcho;
impl rtc_audio::Echo for NoEcho {
    fn render(&mut self, _frame: &mut [i16]) {}
    fn capture(&mut self, _frame: &mut [i16], _delay_ms: i32) {}
}

fn main() {
    let audio = rtc_audio::Audio::start(rtc_audio::Config::default(), Box::new(NoEcho), Box::new(|_| {}));
    audio.set_active(true);
    std::thread::sleep(std::time::Duration::from_millis(300));
    for _ in 0..3 {
        audio.play(rtc_audio::test_sound(), 1.0, false);
        std::thread::sleep(std::time::Duration::from_millis(700));
    }
    println!("open: {:?} {:?}", audio.open(), audio.device_names());
}
