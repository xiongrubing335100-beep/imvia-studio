use crate::protocol::{CredentialPair, HelperError};

pub enum PromptOutcome {
    Candidate(CredentialPair),
    Cancelled,
}

pub trait CredentialPrompt {
    fn prompt(&self) -> Result<PromptOutcome, HelperError>;
}

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub struct UnsupportedCredentialPrompt;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl CredentialPrompt for UnsupportedCredentialPrompt {
    fn prompt(&self) -> Result<PromptOutcome, HelperError> { Err(HelperError::new("PLATFORM_UNSUPPORTED")) }
}
