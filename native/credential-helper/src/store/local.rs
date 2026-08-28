use std::env;
use std::fs::{self, create_dir_all, read, remove_file, rename, set_permissions, write};
use std::path::{Path, PathBuf};

use crate::protocol::{decode_pair, decode_values, encode_pair, encode_values, valid_profile_id, CredentialValues, HelperError};
use crate::store::{CredentialStore, StoreStatus};

#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};

pub const LEGACY_FILE_NAME: &str = "lovart-credentials-v1.json";
pub const PROFILE_DIRECTORY: &str = "provider-credentials-v1";

/// A private local-file store. It deliberately never calls macOS Keychain or
/// Windows Credential Manager, so workbench startup cannot open an OS auth sheet.
pub struct LocalCredentialStore;

fn data_directory() -> Result<PathBuf, HelperError> {
    if let Some(data_directory) = env::var_os("IMVIA_DATA_DIR") {
        let path = PathBuf::from(data_directory);
        if path.is_absolute() { return Ok(path); }
    }
    #[cfg(windows)]
    let base = env::var_os("APPDATA").or_else(|| env::var_os("USERPROFILE"));
    #[cfg(not(windows))]
    let base = env::var_os("HOME");
    base.map(|value| PathBuf::from(value).join("IMVIA Studio"))
        .ok_or_else(|| HelperError::new("CREDENTIAL_STORE_DENIED"))
}

pub fn credential_path(profile_id: Option<&str>) -> Result<PathBuf, HelperError> {
    let base = data_directory()?;
    match profile_id {
        None => Ok(base.join(LEGACY_FILE_NAME)),
        Some(value) if valid_profile_id(value) => Ok(base.join(PROFILE_DIRECTORY).join(format!("{value}.json"))),
        Some(_) => Err(HelperError::new("UPSTREAM_SECURITY_REJECTED")),
    }
}

fn private_permissions(path: &Path) -> Result<(), HelperError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|_| HelperError::new("CREDENTIAL_STORE_DENIED"))?;
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
        set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| HelperError::new("CREDENTIAL_STORE_DENIED"))?;
    }
    Ok(())
}

fn read_values(path: &Path, legacy: bool) -> Result<CredentialValues, HelperError> {
    match read(path) {
        Ok(bytes) if legacy => decode_pair(zeroize::Zeroizing::new(bytes)).map(|pair| pair.into_values()),
        Ok(bytes) => decode_values(zeroize::Zeroizing::new(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(HelperError::new("SETUP_REQUIRED")),
        Err(_) => Err(HelperError::new("CREDENTIAL_STORE_DENIED")),
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), HelperError> {
    rename(source, destination).map_err(|_| HelperError::new("CREDENTIAL_STORE_DENIED"))
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), HelperError> {
    use std::os::windows::ffi::OsStrExt;
    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let destination_wide: Vec<u16> = destination.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let replaced = unsafe {
        MoveFileExW(source_wide.as_ptr(), destination_wide.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)
    };
    if replaced == 0 { Err(HelperError::new("CREDENTIAL_STORE_DENIED")) } else { Ok(()) }
}

impl CredentialStore for LocalCredentialStore {
    fn status(&self, profile_id: Option<&str>) -> StoreStatus {
        match credential_path(profile_id).and_then(|path| read_values(&path, profile_id.is_none())) {
            Ok(_) => StoreStatus::Connected,
            Err(_) => StoreStatus::SetupRequired,
        }
    }

    fn read(&self, profile_id: Option<&str>) -> Result<CredentialValues, HelperError> {
        read_values(&credential_path(profile_id)?, profile_id.is_none())
    }

    fn write(&self, profile_id: Option<&str>, values: &CredentialValues) -> Result<(), HelperError> {
        let path = credential_path(profile_id)?;
        let parent = path.parent().ok_or_else(|| HelperError::new("CREDENTIAL_STORE_DENIED"))?;
        private_directory(parent)?;
        let bytes = if profile_id.is_none() {
            encode_pair(&CredentialValues { values: values.values.clone() }.into_pair()?)?
        } else {
            encode_values(values)?
        };
        let file_name = path.file_name().and_then(|value| value.to_str()).ok_or_else(|| HelperError::new("CREDENTIAL_STORE_DENIED"))?;
        let temporary = parent.join(format!(".{file_name}.{}.tmp", std::process::id()));
        let result = (|| {
            write(&temporary, bytes.as_slice()).map_err(|_| HelperError::new("CREDENTIAL_STORE_DENIED"))?;
            private_permissions(&temporary)?;
            replace_file(&temporary, &path)?;
            private_permissions(&path)
        })();
        if result.is_err() { let _ = remove_file(&temporary); }
        result
    }

    fn clear(&self, profile_id: Option<&str>) -> Result<(), HelperError> {
        match remove_file(credential_path(profile_id)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(HelperError::new("CREDENTIAL_STORE_DENIED")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::replace_file;
    use std::fs::{create_dir, read, remove_dir_all, write};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn replaces_an_existing_profile_without_a_delete_gap() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let directory = std::env::temp_dir().join(format!("imvia-credential-replace-{}-{unique}", std::process::id()));
        create_dir(&directory).unwrap();
        let destination = directory.join("profile.json");
        let temporary = directory.join("profile.tmp");
        write(&destination, b"old").unwrap();
        write(&temporary, b"new").unwrap();
        replace_file(&temporary, &destination).unwrap();
        assert_eq!(read(&destination).unwrap(), b"new");
        assert!(!temporary.exists());
        remove_dir_all(directory).unwrap();
    }
}
