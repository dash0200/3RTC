//! The data channels every 3RTC connection has, as the web app opens them
//! (`client-ts/src/webrtc/usePeerMesh.ts`, `config.ts`).

use libwebrtc::data_channel::DataChannelInit;
use rtc_protocol::PeerId;

/// The bulk channel's fixed id (pre-negotiated on both sides; web: `BULK_CHANNEL_ID`).
pub const BULK_CHANNEL_ID: i32 = 512;

/// Label of the bulk channel (files, video stream, images).
pub const BULK_LABEL: &str = "bulk";

/// Label of the main channel the offering side opens: `chat-<the other peer's id>`.
#[must_use]
pub fn main_label(target: &PeerId) -> String {
    format!("chat-{target}")
}

/// Settings for the main channel: ordered, reliable, JSON messages.
#[must_use]
pub fn main_init() -> DataChannelInit {
    DataChannelInit {
        ordered: true,
        ..DataChannelInit::default()
    }
}

/// Settings for the bulk channel: pre-negotiated with id 512 on both ends, ordered, reliable.
#[must_use]
pub fn bulk_init() -> DataChannelInit {
    DataChannelInit {
        ordered: true,
        negotiated: true,
        id: BULK_CHANNEL_ID,
        ..DataChannelInit::default()
    }
}
