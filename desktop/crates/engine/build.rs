//! libwebrtc's screen capture on Linux talks to the desktop portal through GLib/GIO (the
//! libwebrtc crate's build doesn't link them). Windows needs nothing extra.

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        for lib in ["gio-2.0", "gobject-2.0", "glib-2.0"] {
            println!("cargo:rustc-link-lib=dylib={lib}");
        }
    }
}
