//! On Windows, links the 3RTC logo into `3rtc.exe` as its icon (what Explorer, the taskbar and
//! shortcuts show): `assets/windows/3rtc.rc` names `3rtc.ico`, which `packaging/make-icon.py`
//! draws from the same logo as the window icon. Other targets need nothing.

fn main() -> Result<(), embed_resource::CompilationResult> {
    println!("cargo:rerun-if-changed=assets/windows/3rtc.rc");
    println!("cargo:rerun-if-changed=assets/windows/3rtc.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return Ok(());
    }
    // only the app itself, not the examples; a missing resource compiler fails the build (GPUI
    // needs one for its manifest anyway), so a release can't quietly ship without the icon
    embed_resource::compile_for(
        "assets/windows/3rtc.rc",
        ["3rtc"],
        embed_resource::ParamsIncludeDirs(["assets/windows"]),
    )
    .manifest_required()
}
