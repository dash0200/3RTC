//! Identifiers, as distinct types so one can't be passed where another belongs.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, de};

/// Why an identifier was rejected.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IdError {
    /// Room codes are exactly five digits (the server's rule).
    #[error("room code must be 5 digits, got {0:?}")]
    BadRoomCode(String),
    /// Peer and client ids are non-empty, at most 64 characters, with no control characters.
    #[error("bad id {0:?}")]
    BadId(String),
}

fn check_id(s: &str) -> Result<(), IdError> {
    if s.is_empty() || s.len() > 64 || s.chars().any(char::is_control) {
        return Err(IdError::BadId(s.to_owned()));
    }
    Ok(())
}

macro_rules! string_id {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Wraps a string after checking it's a usable id.
            ///
            /// # Errors
            /// [`IdError::BadId`] for an empty, overlong or control-character id.
            pub fn new(s: impl Into<String>) -> Result<Self, IdError> {
                let s = s.into();
                check_id(&s)?;
                Ok(Self(s))
            }

            /// The id as text.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = String::deserialize(d)?;
                Self::new(s).map_err(de::Error::custom)
            }
        }
    };
}

string_id!(
    /// One app's place in one room: a new one each time the app starts (like the web app's).
    PeerId
);
string_id!(
    /// One app install: stays the same across restarts and rejoins (games give a returning
    /// player their seat back by it).
    ClientId
);

/// A room code: five digits, `"12345"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RoomId([u8; 5]);

impl RoomId {
    /// Parses a room code.
    ///
    /// # Errors
    /// [`IdError::BadRoomCode`] unless it is exactly five ASCII digits.
    pub fn parse(s: &str) -> Result<Self, IdError> {
        let bytes = s.as_bytes();
        match <[u8; 5]>::try_from(bytes) {
            Ok(code) if code.iter().all(u8::is_ascii_digit) => Ok(Self(code)),
            _ => Err(IdError::BadRoomCode(s.to_owned())),
        }
    }

    /// The code as text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        // Only ASCII digits are ever stored (checked in `parse`).
        std::str::from_utf8(&self.0).unwrap_or("00000")
    }
}

impl fmt::Display for RoomId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for RoomId {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for RoomId {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        // The server sends the code as a string; older builds sent a number.
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Text(String),
            Number(u32),
        }
        let text = match Raw::deserialize(d)? {
            Raw::Text(t) => t,
            Raw::Number(n) => format!("{n:05}"),
        };
        Self::parse(&text).map_err(de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_codes_are_five_digits() {
        assert_eq!(RoomId::parse("01234").unwrap().as_str(), "01234");
        for bad in ["1234", "123456", "12a45", "", "１２３４５"] {
            assert!(RoomId::parse(bad).is_err(), "{bad:?} accepted");
        }
    }

    #[test]
    fn room_code_reads_text_or_number() {
        let a: RoomId = serde_json::from_str("\"42424\"").unwrap();
        let b: RoomId = serde_json::from_str("42424").unwrap();
        assert_eq!(a, b);
        assert_eq!(serde_json::to_string(&a).unwrap(), "\"42424\"");
    }

    #[test]
    fn ids_reject_junk() {
        assert!(PeerId::new("").is_err());
        assert!(PeerId::new("a\nb").is_err());
        assert!(PeerId::new("x".repeat(65)).is_err());
        assert!(serde_json::from_str::<PeerId>("\"\"").is_err());
        assert_eq!(PeerId::new("peer_ab12").unwrap().to_string(), "peer_ab12");
    }
}
