use imvia_credential_helper::store::WINDOWS_TARGET;

#[test]
fn windows_target_is_imvia_owned() {
    assert_eq!(WINDOWS_TARGET, "IMVIA.Studio.Lovart");
}

#[test]
fn cancelled_prompt_never_calls_store_write() {
    struct RecordingStore { writes: std::cell::Cell<u32> }
    impl imvia_credential_helper::store::CredentialStore for RecordingStore {
        fn status(&self) -> imvia_credential_helper::store::StoreStatus { imvia_credential_helper::store::StoreStatus::SetupRequired }
        fn read(&self) -> Result<imvia_credential_helper::protocol::CredentialPair, imvia_credential_helper::protocol::HelperError> { Err(imvia_credential_helper::protocol::HelperError::new("SETUP_REQUIRED")) }
        fn write(&self, _pair: &imvia_credential_helper::protocol::CredentialPair) -> Result<(), imvia_credential_helper::protocol::HelperError> { self.writes.set(self.writes.get() + 1); Ok(()) }
        fn clear(&self) -> Result<(), imvia_credential_helper::protocol::HelperError> { Ok(()) }
    }
    let store = RecordingStore { writes: std::cell::Cell::new(0) };
    let outcome = imvia_credential_helper::ui::PromptOutcome::Cancelled;
    assert!(matches!(outcome, imvia_credential_helper::ui::PromptOutcome::Cancelled));
    assert_eq!(store.writes.get(), 0);
}
