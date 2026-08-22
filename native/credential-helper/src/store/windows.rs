use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};

use crate::protocol::{decode_pair, encode_pair, CredentialPair, HelperError};
use crate::store::{CredentialStore, StoreStatus, WINDOWS_TARGET};

pub struct WindowsCredentialStore;

fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(std::iter::once(0)).collect() }

fn map_error() -> HelperError {
    match unsafe { GetLastError() } {
        1168 => HelperError::new("SETUP_REQUIRED"),
        1223 => HelperError::new("SETUP_CANCELLED"),
        _ => HelperError::new("CREDENTIAL_STORE_DENIED"),
    }
}

impl CredentialStore for WindowsCredentialStore {
    fn status(&self) -> StoreStatus {
        match self.read() { Ok(_) => StoreStatus::Connected, Err(_) => StoreStatus::SetupRequired }
    }

    fn read(&self) -> Result<CredentialPair, HelperError> {
        let target = wide(WINDOWS_TARGET);
        let mut raw: *mut CREDENTIALW = null_mut();
        let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut raw) };
        if ok == 0 || raw.is_null() { return Err(map_error()); }
        let result = unsafe {
            let credential = &*raw;
            if credential.CredentialBlob.is_null() || credential.CredentialBlobSize == 0 || credential.CredentialBlobSize > 64 * 1024 {
                Err(HelperError::new("CREDENTIAL_STORE_DENIED"))
            } else {
                let bytes = std::slice::from_raw_parts(credential.CredentialBlob as *const u8, credential.CredentialBlobSize as usize).to_vec();
                decode_pair(zeroize::Zeroizing::new(bytes))
            }
        };
        unsafe { CredFree(raw as *const _); }
        result
    }

    fn write(&self, pair: &CredentialPair) -> Result<(), HelperError> {
        let mut blob = encode_pair(pair)?;
        if blob.len() > u32::MAX as usize { return Err(HelperError::new("CREDENTIAL_STORE_DENIED")); }
        let target = wide(WINDOWS_TARGET);
        let username = wide("credentials");
        let credential = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_ptr() as *mut u16,
            Comment: null_mut(),
            LastWritten: windows_sys::Win32::Foundation::FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: null_mut(),
            TargetAlias: null_mut(),
            UserName: username.as_ptr() as *mut u16,
        };
        let ok = unsafe { CredWriteW(&credential, 0) };
        if ok == 0 { return Err(map_error()); }
        Ok(())
    }

    fn clear(&self) -> Result<(), HelperError> {
        let target = wide(WINDOWS_TARGET);
        let ok = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok == 0 {
            let error = unsafe { GetLastError() };
            if error != 1168 { return Err(map_error()); }
        }
        Ok(())
    }
}
