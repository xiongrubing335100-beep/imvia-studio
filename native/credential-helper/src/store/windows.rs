// Platform adapter retained for a stable helper layout. The connection store
// is local-file based and does not call Windows Credential Manager.
pub type WindowsCredentialStore = crate::store::local::LocalCredentialStore;
