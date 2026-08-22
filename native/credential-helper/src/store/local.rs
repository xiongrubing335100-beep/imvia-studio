use std::env;
use std::fs::{self, create_dir_all, read, remove_file, rename, set_permissions, write};
use std::path::{Path, PathBuf};

use crate::protocol::{decode_pair, encode_pair, CredentialPair, HelperError};
use crate::store::{CredentialStore, StoreStatus};

const FILE_NAME: &str = "lovart-credentials-v1.json";

/// A private local-file store. It deliberately never calls macOS Keychain or
/// Windows Credential Manager, so workbench startup cannot open an OS auth
/// sheet.
pub struct LocalCredentialStore;

fn credential_path() -> Result<PathBuf, HelperError> {
    if let Some(data_directory) = env::var_os("IMVIA_DATA_DIR") {
        let path = PathBuf::from(data_directory);
        if path.is_absolute() { return Ok(path.join(FILE_NAME)); }
    }

    #[cfg(windows)]
    let base = env::var_os("APPDATA").or_else(|| env::var_os("USERPROFILE"));
    #[cfg(not(windows))]
    let base = env::var_os("HOME");
    base.map(|value| PathBuf::from(value).join("IMVIA Studio").join(FILE_NAME))
        .ok_or_else(|| HelperError::new("CREDENTIAL_STORE_DENIED"))
}

fn private_permissions(path: &Path) -> Result<(), HelperError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|_| HelperError::new("CREDENTIAL_STORE_DENIED"))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn private_directory(path: &Path) -> Result<(), HelperError> {
    create_dir_all(path).map_err(|_| HelperError::new("CREDENTIAL_STORE_DENIED"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| HelperError::new("CREDENTIAL_STORE_DENIED"))?;
    }
    Ok(())
}

fn read_pair(path: &Path) -> Result<CredentialPair, HelperError> {
    match read(path) {
        Ok(bytes) => decode_pair(zeroize::Zeroizing::new(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(HelperError::new("SETUP_REQUIRED")),
        Err(_) => Err(HelperError::new("CREDENTIAL_STORE_DENIED")),
    }
}

impl CredentialStore for LocalCredentialStore {
    fn status(&self) -> StoreStatus {
        match credential_path().and_then(|path| read_pair(&path)) {
            Ok(_) => StoreStatus::Connected,
            Err(_) => StoreStatus::SetupRequired,
        }
    }

    fn read(&self) -> Result<CredentialPair, HelperError> { read_pair(&credential_path()?) }

    fn write(&self, pair: &CredentialPair) -> Result<(), HelperError> {
        let path = credential_path()?;
        let parent = path.parent().ok_or_else(|| HelperError::new("CREDENTIAL_STORE_DENIED"))?;
        private_directory(parent)?;
        let bytes = encode_pair(pair)?;
        let temporary = parent.join(format!(".{FILE_NAME}.{}.tmp", std::process::id()));
        write(&temporary, bytes.as_slice()).map_err(|_| HelperError::new("CREDENTIAL_STORE_DENIED"))?;
        private_permissions(&temporary)?;
        #[cfg(windows)]
        { let _ = remove_file(&path); }
        rename(&temporary, &path).map_err(|_| {
            let _ = remove_file(&temporary);
            HelperError::new("CREDENTIAL_STORE_DENIED")
        })?;
        private_permissions(&path)
    }

    fn clear(&self) -> Result<(), HelperError> {
        match remove_file(credential_path()?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(HelperError::new("CREDENTIAL_STORE_DENIED")),
        }
    }
}
