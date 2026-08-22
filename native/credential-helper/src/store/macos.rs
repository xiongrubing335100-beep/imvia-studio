// Platform adapter retained for a stable helper layout. The connection store
// is local-file based and does not call Security.framework/Keychain.
pub type MacCredentialStore = crate::store::local::LocalCredentialStore;
