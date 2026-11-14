//! Between the protocol's browser-shaped SDP and candidates and libwebrtc's types.

use libwebrtc::ice_candidate::IceCandidate as RtcCandidate;
use libwebrtc::session_description::{SdpType as RtcSdpType, SessionDescription as RtcDescription};
use rtc_protocol::sdp::{IceCandidate, SdpType, SessionDescription};

/// A description or candidate libwebrtc couldn't parse.
#[derive(Debug, thiserror::Error)]
#[error("libwebrtc rejected it: {0}")]
pub struct ParseError(String);

const fn to_rtc_type(kind: SdpType) -> RtcSdpType {
    match kind {
        SdpType::Offer => RtcSdpType::Offer,
        SdpType::Answer => RtcSdpType::Answer,
        SdpType::Pranswer => RtcSdpType::PrAnswer,
        SdpType::Rollback => RtcSdpType::Rollback,
    }
}

const fn from_rtc_type(kind: RtcSdpType) -> SdpType {
    match kind {
        RtcSdpType::Offer => SdpType::Offer,
        RtcSdpType::Answer => SdpType::Answer,
        RtcSdpType::PrAnswer => SdpType::Pranswer,
        RtcSdpType::Rollback => SdpType::Rollback,
    }
}

/// A received offer or answer, for libwebrtc.
///
/// # Errors
/// [`ParseError`] if the SDP doesn't parse.
pub fn description_in(d: &SessionDescription) -> Result<RtcDescription, ParseError> {
    RtcDescription::parse(&d.sdp, to_rtc_type(d.kind)).map_err(|e| ParseError(e.to_string()))
}

/// A local offer or answer, to send.
#[must_use]
pub fn description_out(d: &RtcDescription) -> SessionDescription {
    SessionDescription {
        kind: from_rtc_type(d.sdp_type()),
        sdp: d.to_string(),
    }
}

/// A received ICE candidate, for libwebrtc.
///
/// # Errors
/// [`ParseError`] if the candidate line doesn't parse.
pub fn candidate_in(c: &IceCandidate) -> Result<RtcCandidate, ParseError> {
    let mid = c.sdp_mid.as_deref().unwrap_or("0");
    let index = c.sdp_m_line_index.map_or(0, i32::from);
    RtcCandidate::parse(mid, index, &c.candidate).map_err(|e| ParseError(e.to_string()))
}

/// A local ICE candidate, to send.
#[must_use]
pub fn candidate_out(c: &RtcCandidate) -> IceCandidate {
    IceCandidate {
        candidate: c.candidate(),
        sdp_mid: Some(c.sdp_mid()),
        sdp_m_line_index: u16::try_from(c.sdp_mline_index()).ok(),
        username_fragment: None,
    }
}
