//! Creating peer connections with the web app's settings.

use libwebrtc::peer_connection::PeerConnection;
use libwebrtc::peer_connection_factory::{
    ContinualGatheringPolicy, IceServer, IceTransportsType, PeerConnectionFactory, RtcConfiguration,
};

/// The STUN servers the web app uses by default (`client-ts/src/webrtc/config.ts`).
pub const DEFAULT_STUN: [&str; 2] = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"];

/// One ICE server (STUN, or TURN with credentials).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IceServerConfig {
    /// `stun:` / `turn:` URLs.
    pub urls: Vec<String>,
    /// TURN user name.
    pub username: String,
    /// TURN password.
    pub password: String,
}

impl IceServerConfig {
    /// The web app's default STUN servers.
    #[must_use]
    pub fn defaults() -> Vec<Self> {
        DEFAULT_STUN
            .iter()
            .map(|u| Self {
                urls: vec![(*u).to_owned()],
                username: String::new(),
                password: String::new(),
            })
            .collect()
    }
}

/// Could not create a peer connection.
#[derive(Debug, thiserror::Error)]
#[error("couldn't create a peer connection: {0}")]
pub struct CreateError(String);

/// Makes peer connections. One per app: it owns libwebrtc's threads and audio device.
pub struct Factory {
    inner: PeerConnectionFactory,
    ice: Vec<IceServerConfig>,
}

impl Factory {
    /// A factory using these ICE servers.
    #[must_use]
    pub fn new(ice: Vec<IceServerConfig>) -> Self {
        crate::native_log::forward_audio_logs();
        Self {
            inner: PeerConnectionFactory::default(),
            ice,
        }
    }

    /// libwebrtc's factory (for tracks and the audio device).
    #[must_use]
    pub const fn inner(&self) -> &PeerConnectionFactory {
        &self.inner
    }

    /// A new peer connection, gathering candidates continually (networks change on laptops).
    ///
    /// # Errors
    /// [`CreateError`] if libwebrtc refuses the configuration.
    pub fn peer_connection(&self) -> Result<PeerConnection, CreateError> {
        // non-exhaustive upstream: start from its defaults and set what we rely on
        let mut config = RtcConfiguration::default();
        config.ice_servers = self
            .ice
            .iter()
            .map(|s| IceServer {
                urls: s.urls.clone(),
                username: s.username.clone(),
                password: s.password.clone(),
            })
            .collect();
        config.continual_gathering_policy = ContinualGatheringPolicy::GatherContinually;
        config.ice_transport_type = IceTransportsType::All;
        self.inner
            .create_peer_connection(config)
            .map_err(|e| CreateError(e.to_string()))
    }
}
