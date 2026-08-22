// Platform adapter retained for a stable helper layout. The connection store
// is local-file based and does not call Security.framework/Keychain.
pub use crate::store::local::LocalCredentialStore as MacCredentialStore;
