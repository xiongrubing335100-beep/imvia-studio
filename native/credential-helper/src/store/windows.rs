// Platform adapter retained for a stable helper layout. The connection store
// is local-file based and does not call Windows Credential Manager.
pub use crate::store::local::LocalCredentialStore as WindowsCredentialStore;
