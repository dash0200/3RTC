//! Session descriptions and ICE candidates, in the browser's JSON shape
//! (`RTCSessionDescriptionInit`, `RTCIceCandidateInit`).

use serde::{Deserialize, Serialize};

/// Offer or answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SdpType {
    /// An offer.
    Offer,
    /// An answer.
    Answer,
    /// A provisional answer.
    Pranswer,
    /// Roll back an offer (glare).
    Rollback,
}

/// An SDP offer or answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionDescription {
    /// Offer or answer.
    #[serde(rename = "type")]
    pub kind: SdpType,
    /// The SDP text (absent only for a rollback).
    #[serde(default)]
    pub sdp: String,
}

/// One ICE candidate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IceCandidate {
    /// The `candidate:` line; empty means "end of candidates".
    pub candidate: String,
    /// Media section id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdp_mid: Option<String>,
    /// Media section index.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdp_m_line_index: Option<u16>,
    /// ICE username fragment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username_fragment: Option<String>,
}
