use crate::protocol::{CredentialPair, HelperError};

pub const MACOS_SERVICE: &str = "ai.imvia.studio.lovart";
pub const MACOS_ACCOUNT: &str = "credentials";
pub const WINDOWS_TARGET: &str = "IMVIA.Studio.Lovart";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum StoreStatus { Connected, SetupRequired }

pub trait CredentialStore {
    fn status(&self) -> StoreStatus;
    fn read(&self) -> Result<CredentialPair, HelperError>;
    fn write(&self, pair: &CredentialPair) -> Result<(), HelperError>;
    fn clear(&self) -> Result<(), HelperError>;
}

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub struct UnsupportedCredentialStore;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl CredentialStore for UnsupportedCredentialStore {
    fn status(&self) -> StoreStatus { StoreStatus::SetupRequired }
    fn read(&self) -> Result<CredentialPair, HelperError> { Err(HelperError::new("PLATFORM_UNSUPPORTED")) }
    fn write(&self, _pair: &CredentialPair) -> Result<(), HelperError> { Err(HelperError::new("PLATFORM_UNSUPPORTED")) }
    fn clear(&self) -> Result<(), HelperError> { Err(HelperError::new("PLATFORM_UNSUPPORTED")) }
}
