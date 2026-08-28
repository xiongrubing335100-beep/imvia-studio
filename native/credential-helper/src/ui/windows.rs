use std::collections::BTreeMap;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{GetLastError, HWND};
use windows_sys::Win32::Security::Credentials::{
    CredUIPromptForWindowsCredentialsW, CredUnPackAuthenticationBufferW, CREDUI_INFOW, CREDUIWIN_GENERIC,
};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use zeroize::Zeroize;

use crate::protocol::{CredentialField, CredentialValues, HelperError};
use crate::ui::{CredentialPrompt, PromptOutcome};

pub struct WindowsCredentialPrompt;

impl CredentialPrompt for WindowsCredentialPrompt {
    fn prompt(&self, fields: &[CredentialField]) -> Result<PromptOutcome, HelperError> {
        let mut values = BTreeMap::new();
        for field in fields {
            let Some(value) = prompt_secure_field(&field.label)? else { return Ok(PromptOutcome::Cancelled); };
            values.insert(field.id.clone(), value);
        }
        CredentialValues::new(values, fields).map(PromptOutcome::Candidate)
    }
}

fn prompt_secure_field(label: &str) -> Result<Option<String>, HelperError> {
    let mut auth_package = 0u32;
    let mut buffer = null_mut();
    let mut buffer_size = 0u32;
    let mut save = 0i32;
    let caption = wide(&format!("连接 API 提供商：{label}"));
    let info = CREDUI_INFOW {
        cbSize: std::mem::size_of::<CREDUI_INFOW>() as u32,
        hwndParent: 0 as HWND,
        pszMessageText: caption.as_ptr(),
        pszCaptionText: caption.as_ptr(),
        hbmBanner: null_mut(),
    };
    let result = unsafe {
        CredUIPromptForWindowsCredentialsW(&info, 0, &mut auth_package, null(), 0, &mut buffer, &mut buffer_size, &mut save, CREDUIWIN_GENERIC)
    };
    if result == 1223 || unsafe { GetLastError() } == 1223 { return Ok(None); }
    if result != 0 || buffer.is_null() || buffer_size == 0 { return Err(HelperError::new("CREDENTIAL_SETUP_FAILED")); }
    let mut username = vec![0u16; 1024];
    let mut username_size = username.len() as u32;
    let mut domain = vec![0u16; 1024];
    let mut domain_size = domain.len() as u32;
    let mut password = vec![0u16; 2048];
    let mut password_size = password.len() as u32;
    let unpacked = unsafe {
        CredUnPackAuthenticationBufferW(0, buffer, buffer_size, username.as_mut_ptr(), &mut username_size, domain.as_mut_ptr(), &mut domain_size, password.as_mut_ptr(), &mut password_size)
    };
    unsafe {
        std::slice::from_raw_parts_mut(buffer as *mut u8, buffer_size as usize).zeroize();
        CoTaskMemFree(buffer as *const _);
    }
    username.zeroize();
    domain.zeroize();
    if unpacked == 0 { password.zeroize(); return Err(HelperError::new("CREDENTIAL_SETUP_INVALID")); }
    let value = String::from_utf16_lossy(&password[..password_size.saturating_sub(1) as usize]);
    password.zeroize();
    Ok(Some(value))
}

fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(std::iter::once(0)).collect() }
