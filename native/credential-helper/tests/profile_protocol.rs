use std::collections::BTreeMap;

use imvia_credential_helper::protocol::{CredentialField, CredentialValues, RequestMessage, ResultMessage};

fn request(value: &str) -> RequestMessage { serde_json::from_str(value).unwrap() }

#[test]
fn accepts_legacy_requests_and_valid_profile_requests() {
    assert!(request(r#"{"v":1,"type":"request","op":"status","request_id":"one"}"#).validate("status").is_ok());
    assert!(request(r#"{"v":1,"type":"request","op":"configure","request_id":"two","profile_id":"profile-primary","fields":[{"id":"api_key","label":"API Key","secret":true,"required":true}]}"#).validate("configure").is_ok());
}

#[test]
fn rejects_profile_traversal_and_unsafe_fields() {
    assert!(request(r#"{"v":1,"type":"request","op":"read","profile_id":"../lovart-credentials-v1"}"#).validate("read").is_err());
    assert!(request(r#"{"v":1,"type":"request","op":"configure","profile_id":"profile-primary","fields":[{"id":"../secret","label":"Secret","secret":true,"required":true}]}"#).validate("configure").is_err());
}

#[test]
fn dynamic_read_values_are_scoped_to_the_values_object() {
    let fields = [CredentialField { id: "api_key".into(), label: "API Key".into(), secret: true, required: true }];
    let values = CredentialValues::new(BTreeMap::from([("api_key".into(), "private-value".into())]), &fields).unwrap();
    let serialized = serde_json::to_string(&ResultMessage::with_values(values)).unwrap();
    assert_eq!(serialized, r#"{"v":1,"type":"result","status":"connected","code":"CONNECTED","values":{"api_key":"private-value"}}"#);
    let status = serde_json::to_string(&ResultMessage::connected("CONNECTED")).unwrap();
    assert!(!status.contains("private-value"));
    assert!(!status.contains("values"));
}
