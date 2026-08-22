use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

pub const PROTOCOL_VERSION: u8 = 1;

#[derive(Deserialize)]
pub struct RequestMessage {
    pub v: u8,
    #[serde(rename = "type")]
    pub message_type: String,
    pub op: Option<String>,
}

#[derive(Deserialize)]
pub struct VerdictMessage {
    pub v: u8,
    #[serde(rename = "type")]
    pub message_type: String,
    pub accepted: bool,
    pub code: String,
}

#[derive(Serialize)]
pub struct CandidateMessage<'a> {
    pub v: u8,
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub access_key: &'a str,
    pub secret_key: &'a str,
}

#[derive(Serialize)]
pub struct ResultMessage {
    pub v: u8,
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credentials: Option<CredentialWire>,
}

#[derive(Serialize)]
pub struct CredentialWire {
    pub access_key: String,
    pub secret_key: String,
}

impl ResultMessage {
    pub fn new(status: &'static str, code: impl Into<Option<String>>) -> Self {
        Self { v: PROTOCOL_VERSION, message_type: "result", status, code: code.into(), checked_at: None, credentials: None }
    }

    pub fn connected(code: &str) -> Self { Self::new("connected", Some(code.to_owned())) }

    pub fn setup_required(code: &str) -> Self { Self::new("setup_required", Some(code.to_owned())) }

    pub fn with_credentials(pair: CredentialPair) -> Self {
        let wire = CredentialWire { access_key: pair.access_key, secret_key: pair.secret_key };
        let mut result = Self::new("connected", Some("CONNECTED".to_owned()));
        result.credentials = Some(wire);
        result
    }
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub struct CredentialPair {
    pub access_key: String,
    pub secret_key: String,
}

impl CredentialPair {
    pub fn new(access_key: String, secret_key: String) -> Result<Self, HelperError> {
        let access_key = access_key.trim().to_owned();
        let secret_key = secret_key.trim().to_owned();
        if access_key.is_empty() || secret_key.is_empty() { return Err(HelperError::new("SETUP_INVALID")); }
        Ok(Self { access_key, secret_key })
    }
}

pub fn encode_pair(pair: &CredentialPair) -> Result<Zeroizing<Vec<u8>>, HelperError> {
    let value = serde_json::to_vec(&serde_json::json!({ "access_key": pair.access_key, "secret_key": pair.secret_key }))
        .map_err(|_| HelperError::new("CREDENTIAL_STORE_DENIED"))?;
    Ok(Zeroizing::new(value))
}

pub fn decode_pair(bytes: Zeroizing<Vec<u8>>) -> Result<CredentialPair, HelperError> {
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| HelperError::new("CREDENTIAL_STORE_DENIED"))?;
    let access = value.get("access_key").and_then(serde_json::Value::as_str).unwrap_or_default().to_owned();
    let secret = value.get("secret_key").and_then(serde_json::Value::as_str).unwrap_or_default().to_owned();
    CredentialPair::new(access, secret)
}

pub struct HelperError { pub code: &'static str }

impl HelperError {
    pub const fn new(code: &'static str) -> Self { Self { code } }
}
