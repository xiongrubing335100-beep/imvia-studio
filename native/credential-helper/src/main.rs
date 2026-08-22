use std::env;
use std::io::{self, BufRead, Write};

use imvia_credential_helper::protocol::{CandidateMessage, CredentialPair, RequestMessage, ResultMessage, VerdictMessage, PROTOCOL_VERSION};
use imvia_credential_helper::store::{CredentialStore, StoreStatus};
use imvia_credential_helper::ui::{CredentialPrompt, PromptOutcome};

fn emit(message: &ResultMessage) -> Result<(), imvia_credential_helper::protocol::HelperError> {
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    serde_json::to_writer(&mut handle, message).map_err(|_| imvia_credential_helper::protocol::HelperError::new("HELPER_LAUNCH_FAILED"))?;
    handle.write_all(b"\n").map_err(|_| imvia_credential_helper::protocol::HelperError::new("HELPER_LAUNCH_FAILED"))?;
    handle.flush().map_err(|_| imvia_credential_helper::protocol::HelperError::new("HELPER_LAUNCH_FAILED"))
}

fn read_line() -> Result<String, imvia_credential_helper::protocol::HelperError> {
    let stdin = io::stdin();
    let mut line = String::new();
    stdin.lock().read_line(&mut line).map_err(|_| imvia_credential_helper::protocol::HelperError::new("HELPER_LAUNCH_FAILED"))?;
    if line.is_empty() || line.len() > 16 * 1024 { return Err(imvia_credential_helper::protocol::HelperError::new("UPSTREAM_SECURITY_REJECTED")); }
    Ok(line)
}

fn require_request(expected_operation: &str) -> Result<(), imvia_credential_helper::protocol::HelperError> {
    let request: RequestMessage = serde_json::from_str(&read_line()?).map_err(|_| imvia_credential_helper::protocol::HelperError::new("UPSTREAM_SECURITY_REJECTED"))?;
    if request.v != PROTOCOL_VERSION || request.message_type != "request" || request.op.as_deref() != Some(expected_operation) {
        return Err(imvia_credential_helper::protocol::HelperError::new("UPSTREAM_SECURITY_REJECTED"));
    }
    Ok(())
}

fn run<S: CredentialStore, P: CredentialPrompt>(operation: &str, store: &S, prompt: &P) -> Result<(), imvia_credential_helper::protocol::HelperError> {
    require_request(operation)?;
    match operation {
        "status" => {
            let result = match store.status() {
                StoreStatus::Connected => ResultMessage::connected("CONNECTED"),
                StoreStatus::SetupRequired => ResultMessage::setup_required("SETUP_REQUIRED"),
            };
            emit(&result)?;
        }
        "read" => {
            let pair = store.read()?;
            emit(&ResultMessage::with_credentials(pair))?;
        }
        "clear" => {
            store.clear()?;
            emit(&ResultMessage::setup_required("SETUP_REQUIRED"))?;
        }
        "configure" => {
            let outcome = prompt.prompt()?;
            let PromptOutcome::Candidate(pair) = outcome else {
                emit(&ResultMessage::setup_required("SETUP_CANCELLED"))?;
                return Ok(());
            };
            let candidate = CandidateMessage {
                v: PROTOCOL_VERSION,
                message_type: "candidate",
                access_key: &pair.access_key,
                secret_key: &pair.secret_key,
            };
            let stdout = io::stdout();
            let mut handle = stdout.lock();
            serde_json::to_writer(&mut handle, &candidate).map_err(|_| imvia_credential_helper::protocol::HelperError::new("HELPER_LAUNCH_FAILED"))?;
            handle.write_all(b"\n").map_err(|_| imvia_credential_helper::protocol::HelperError::new("HELPER_LAUNCH_FAILED"))?;
            handle.flush().map_err(|_| imvia_credential_helper::protocol::HelperError::new("HELPER_LAUNCH_FAILED"))?;
            drop(handle);
            let verdict: VerdictMessage = serde_json::from_str(&read_line()?).map_err(|_| imvia_credential_helper::protocol::HelperError::new("UPSTREAM_SECURITY_REJECTED"))?;
            if verdict.v != PROTOCOL_VERSION || verdict.message_type != "verdict" || verdict.code.len() > 64 {
                return Err(imvia_credential_helper::protocol::HelperError::new("UPSTREAM_SECURITY_REJECTED"));
            }
            if verdict.accepted {
                store.write(&pair)?;
                emit(&ResultMessage::connected("CONNECTED"))?;
            } else {
                emit(&ResultMessage::setup_required(&verdict.code))?;
            }
        }
        _ => return Err(imvia_credential_helper::protocol::HelperError::new("UPSTREAM_SECURITY_REJECTED")),
    }
    Ok(())
}

fn main() {
    let mut args = env::args().skip(1);
    let operation = args.next().unwrap_or_default();
    if args.next().is_some() || !matches!(operation.as_str(), "status" | "configure" | "read" | "clear") {
        std::process::exit(64);
    }

    #[cfg(target_os = "macos")]
    let store = imvia_credential_helper::store::macos::MacCredentialStore;
    #[cfg(target_os = "windows")]
    let store = imvia_credential_helper::store::windows::WindowsCredentialStore;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let store = imvia_credential_helper::store::UnsupportedCredentialStore;

    #[cfg(target_os = "macos")]
    let prompt = imvia_credential_helper::ui::macos::MacCredentialPrompt;
    #[cfg(target_os = "windows")]
    let prompt = imvia_credential_helper::ui::windows::WindowsCredentialPrompt;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let prompt = imvia_credential_helper::ui::UnsupportedCredentialPrompt;

    if let Err(error) = run(&operation, &store, &prompt) {
        let _ = emit(&ResultMessage::setup_required(error.code));
        std::process::exit(1);
    }
}
