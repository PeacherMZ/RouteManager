//! Windows bootstrap preserves the initiating user's profile across over-the-shoulder UAC.
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{bootstrap, user_local_directory};
#[cfg(not(windows))]
pub fn bootstrap() -> Result<bool, String> {
    Ok(false)
}
