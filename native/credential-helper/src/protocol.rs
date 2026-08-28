use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

pub const PROTOCOL_VERSION: u8 = 1;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CredentialField {
    pub id: String,
    pub label: String,
    pub secret: bool,
    pub required: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestMessage {
    pub v: u8,
    #[serde(rename = "type")]
    pub message_type: String,
    pub op: Option<String>,
    pub request_id: Option<String>,
    pub profile_id: Option<String>,
    pub fields: Option<Vec<CredentialField>>,
}

impl RequestMessage {
    pub fn validate(&self, expected_operation: &str) -> Result<(), HelperError> {
        if self.v != PROTOCOL_VERSION || self.message_type != "request" || self.op.as_deref() != Some(expected_operation) {
            return Err(HelperError::new("UPSTREAM_SECURITY_REJECTED"));
        }
        if self.request_id.as_ref().is_some_and(|value| value.is_empty() || value.len() > 128) {
            return Err(HelperError::new("UPSTREAM_SECURITY_REJECTED"));
        }
        match (&self.profile_id, &self.fields) {
            (None, None) => Ok(()),
            (Some(profile_id), fields) if valid_profile_id(profile_id) => {
                if expected_operation == "configure" && fields.is_none() {
                    return Err(HelperError::new("UPSTREAM_SECURITY_REJECTED"));
                }
                if let Some(fields) = fields { validate_fields(fields)?; }
                Ok(())
            }
            _ => Err(HelperError::new("UPSTREAM_SECURITY_REJECTED")),
        }
    }

    pub fn is_legacy(&self) -> bool { self.profile_id.is_none() }
}

pub fn valid_profile_id(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else { return false; };
    value.len() <= 128 && value != "." && value != ".." && first.is_ascii_alphanumeric()
        && chars.all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
}

fn valid_field_id(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else { return false; };
    value.len() <= 64 && first.is_ascii_lowercase()
        && chars.all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || matches!(character, '.' | '_' | '-'))
}

pub fn validate_fields(fields: &[CredentialField]) -> Result<(), HelperError> {
    if fields.is_empty() || fields.len() > 32 { return Err(HelperError::new("UPSTREAM_SECURITY_REJECTED")); }
    let mut seen = BTreeSet::new();
    for field in fields {
        if !valid_field_id(&field.id) || !seen.insert(&field.id) || field.label.trim().is_empty() || field.label.len() > 128 {
            return Err(HelperError::new("UPSTREAM_SECURITY_REJECTED"));
        }
    }
    Ok(())
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_key: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_key: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<&'a BTreeMap<String, String>>,
}

impl<'a> CandidateMessage<'a> {
    pub fn legacy(pair: &'a CredentialPair) -> Self {
        Self { v: PROTOCOL_VERSION, message_type: "candidate", access_key: Some(&pair.access_key), secret_key: Some(&pair.secret_key), values: None }
    }

    pub fn profile(values: &'a CredentialValues) -> Self {
        Self { v: PROTOCOL_VERSION, message_type: "candidate", access_key: None, secret_key: None, values: Some(&values.values) }
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<CredentialValues>,
}

#[derive(Serialize)]
pub struct CredentialWire {
    pub access_key: String,
    pub secret_key: String,
}

impl ResultMessage {
    pub fn new(status: &'static str, code: impl Into<Option<String>>) -> Self {
        Self { v: PROTOCOL_VERSION, message_type: "result", status, code: code.into(), checked_at: None, credentials: None, values: None }
    }

    pub fn connected(code: &str) -> Self { Self::new("connected", Some(code.to_owned())) }
    pub fn setup_required(code: &str) -> Self { Self::new("setup_required", Some(code.to_owned())) }

    pub fn with_credentials(pair: CredentialPair) -> Self {
        let wire = CredentialWire { access_key: pair.access_key.clone(), secret_key: pair.secret_key.clone() };
        let mut result = Self::connected("CONNECTED");
        result.credentials = Some(wire);
        result
    }

    pub fn with_values(values: CredentialValues) -> Self {
        let mut result = Self::connected("CONNECTED");
        result.values = Some(values);
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

    pub fn into_values(self) -> CredentialValues {
        CredentialValues { values: BTreeMap::from([("access_key".to_owned(), self.access_key.clone()), ("secret_key".to_owned(), self.secret_key.clone())]) }
    }
}

#[derive(Serialize, Zeroize, ZeroizeOnDrop)]
#[serde(transparent)]
pub struct CredentialValues {
    pub values: BTreeMap<String, String>,
}

impl CredentialValues {
    pub fn new(values: BTreeMap<String, String>, fields: &[CredentialField]) -> Result<Self, HelperError> {
        validate_fields(fields)?;
        if values.keys().any(|key| !fields.iter().any(|field| field.id == *key)) { return Err(HelperError::new("SETUP_INVALID")); }
        let mut normalized = BTreeMap::new();
        for field in fields {
            let value = values.get(&field.id).map(|value| value.trim()).unwrap_or_default();
            if field.required && value.is_empty() { return Err(HelperError::new("SETUP_INVALID")); }
            if !value.is_empty() { normalized.insert(field.id.clone(), value.to_owned()); }
        }
        if normalized.is_empty() { return Err(HelperError::new("SETUP_INVALID")); }
        Ok(Self { values: normalized })
    }

    pub fn into_pair(self) -> Result<CredentialPair, HelperError> {
        CredentialPair::new(
            self.values.get("access_key").cloned().unwrap_or_default(),
            self.values.get("secret_key").cloned().unwrap_or_default(),
        )
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

pub fn encode_values(values: &CredentialValues) -> Result<Zeroizing<Vec<u8>>, HelperError> {
    serde_json::to_vec(&serde_json::json!({ "values": values.values }))
        .map(Zeroizing::new)
        .map_err(|_| HelperError::new("CREDENTIAL_STORE_DENIED"))
}

pub fn decode_values(bytes: Zeroizing<Vec<u8>>) -> Result<CredentialValues, HelperError> {
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| HelperError::new("CREDENTIAL_STORE_DENIED"))?;
    let values: BTreeMap<String, String> = serde_json::from_value(value.get("values").cloned().unwrap_or(serde_json::Value::Null))
        .map_err(|_| HelperError::new("CREDENTIAL_STORE_DENIED"))?;
    if values.is_empty() || values.iter().any(|(key, value)| !valid_field_id(key) || value.trim().is_empty()) {
        return Err(HelperError::new("CREDENTIAL_STORE_DENIED"));
    }
    Ok(CredentialValues { values })
}

#[derive(Debug)]
pub struct HelperError { pub code: &'static str }

impl HelperError {
    pub const fn new(code: &'static str) -> Self { Self { code } }
}
