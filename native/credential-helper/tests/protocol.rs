use imvia_credential_helper::protocol::{CredentialPair, ResultMessage};

#[test]
fn result_messages_never_serialize_credentials() {
    let value = serde_json::to_string(&ResultMessage::connected("CONNECTED")).unwrap();
    assert_eq!(value, r#"{"v":1,"type":"result","status":"connected","code":"CONNECTED"}"#);
}

#[test]
fn credential_pair_zeroizes_on_drop() {
    fn assert_zeroize_on_drop<T: zeroize::ZeroizeOnDrop>() {}
    assert_zeroize_on_drop::<CredentialPair>();
}
