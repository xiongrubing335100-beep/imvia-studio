use security_framework::passwords::{delete_generic_password, generic_password, set_generic_password, PasswordOptions};
use zeroize::Zeroizing;

use crate::protocol::{decode_pair, encode_pair, CredentialPair, HelperError};
use crate::store::{CredentialStore, StoreStatus, MACOS_ACCOUNT, MACOS_SERVICE};

pub struct MacCredentialStore;

fn map_error(error: impl std::fmt::Display) -> HelperError {
    let text = error.to_string();
    if text.contains("-25300") || text.to_ascii_lowercase().contains("not found") {
        HelperError::new("SETUP_REQUIRED")
    } else {
        HelperError::new("CREDENTIAL_STORE_DENIED")
    }
}

impl CredentialStore for MacCredentialStore {
    fn status(&self) -> StoreStatus {
        match self.read() { Ok(_) => StoreStatus::Connected, Err(_) => StoreStatus::SetupRequired }
    }

    fn read(&self) -> Result<CredentialPair, HelperError> {
        let options = PasswordOptions::new_generic_password(MACOS_SERVICE, MACOS_ACCOUNT);
        let bytes = generic_password(options).map_err(map_error)?;
        decode_pair(Zeroizing::new(bytes))
    }

    fn write(&self, pair: &CredentialPair) -> Result<(), HelperError> {
        let bytes = encode_pair(pair)?;
        set_generic_password(MACOS_SERVICE, MACOS_ACCOUNT, &bytes).map_err(map_error)?;
        Ok(())
    }

    fn clear(&self) -> Result<(), HelperError> {
        match delete_generic_password(MACOS_SERVICE, MACOS_ACCOUNT) {
            Ok(()) => Ok(()),
            Err(error) if error.to_string().contains("-25300") => Ok(()),
            Err(error) => Err(map_error(error)),
        }
    }
}
