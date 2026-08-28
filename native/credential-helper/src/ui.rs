use crate::protocol::{CredentialField, CredentialValues, HelperError};

pub enum PromptOutcome {
    Candidate(CredentialValues),
    Cancelled,
}

pub trait CredentialPrompt {
    fn prompt(&self, fields: &[CredentialField]) -> Result<PromptOutcome, HelperError>;
}

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub struct UnsupportedCredentialPrompt;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl CredentialPrompt for UnsupportedCredentialPrompt {
    fn prompt(&self, _fields: &[CredentialField]) -> Result<PromptOutcome, HelperError> { Err(HelperError::new("PLATFORM_UNSUPPORTED")) }
}
