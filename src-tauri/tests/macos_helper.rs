#[cfg(target_os = "macos")]
#[test]
fn native_helper_synthetic_contracts() {
    let executable = std::env::current_exe().unwrap();
    let helper = executable
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("route-manager-helper");
    let output = std::process::Command::new(helper)
        .arg("self-test")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
}
