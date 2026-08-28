use crate::protocol::{CredentialValues, HelperError};

pub const MACOS_SERVICE: &str = "ai.imvia.studio.lovart";
pub const MACOS_ACCOUNT: &str = "credentials";
pub const WINDOWS_TARGET: &str = "IMVIA.Studio.Lovart";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum StoreStatus { Connected, SetupRequired }

pub trait CredentialStore {
    fn status(&self, profile_id: Option<&str>) -> StoreStatus;
    fn read(&self, profile_id: Option<&str>) -> Result<CredentialValues, HelperError>;
    fn write(&self, profile_id: Option<&str>, values: &CredentialValues) -> Result<(), HelperError>;
    fn clear(&self, profile_id: Option<&str>) -> Result<(), HelperError>;
}

// Lovart connection credentials intentionally use a private local file. The
// legacy service/target constants above remain only for source compatibility;
// this helper never reads or writes those operating-system credential stores.
pub mod local;

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub struct UnsupportedCredentialStore;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl CredentialStore for UnsupportedCredentialStore {
    fn status(&self, _profile_id: Option<&str>) -> StoreStatus { StoreStatus::SetupRequired }
    fn read(&self, _profile_id: Option<&str>) -> Result<CredentialValues, HelperError> { Err(HelperError::new("PLATFORM_UNSUPPORTED")) }
    fn write(&self, _profile_id: Option<&str>, _values: &CredentialValues) -> Result<(), HelperError> { Err(HelperError::new("PLATFORM_UNSUPPORTED")) }
    fn clear(&self, _profile_id: Option<&str>) -> Result<(), HelperError> { Err(HelperError::new("PLATFORM_UNSUPPORTED")) }
}
