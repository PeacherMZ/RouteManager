#[test]
fn installer_never_deletes_user_data_or_terminates_the_app() {
    let template = include_str!("../windows/installer.nsi");
    let hooks = include_str!("../windows/installer-hooks.nsh");
    for forbidden in [
        "RmDir /r \"$APPDATA",
        "RmDir /r \"$LOCALAPPDATA",
        "DeleteAppDataCheckbox",
        "!insertmacro CheckIfAppIsRunning",
        "taskkill",
        "TerminateProcess",
    ] {
        assert!(
            !template.contains(forbidden),
            "unsafe installer operation: {forbidden}"
        );
        assert!(
            !hooks.contains(forbidden),
            "unsafe installer hook: {forbidden}"
        );
    }
    assert!(hooks.contains("Abort"));
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert_eq!(
        config["bundle"]["windows"]["webviewInstallMode"]["type"],
        "offlineInstaller"
    );
    assert_eq!(config["bundle"]["windows"]["allowDowngrades"], false);
    assert_eq!(
        config["bundle"]["windows"]["nsis"]["template"],
        "windows/installer.nsi"
    );
    assert_eq!(config["version"], env!("CARGO_PKG_VERSION"));
}

#[test]
fn release_requires_both_platforms_and_pins_actions() {
    let workflow: serde_yaml::Value =
        serde_yaml::from_str(include_str!("../../.github/workflows/build.yml")).unwrap();
    assert_eq!(workflow["permissions"]["contents"].as_str(), Some("read"));
    let jobs = workflow["jobs"].as_mapping().unwrap();
    for (name, job) in jobs {
        if job["permissions"]["contents"].as_str() == Some("write") {
            assert_eq!(name.as_str(), Some("draft-release"));
        }
        for step in job["steps"].as_sequence().unwrap() {
            if let Some(action) = step["uses"].as_str() {
                let revision = action.split('@').nth(1).unwrap();
                assert_eq!(revision.len(), 40);
                assert!(revision.bytes().all(|b| b.is_ascii_hexdigit()));
            }
        }
    }
    assert_eq!(
        workflow["jobs"]["build"]["strategy"]["matrix"]["include"]
            .as_sequence()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        workflow["jobs"]["draft-release"]["needs"].as_str(),
        Some("build")
    );
    assert!(workflow["jobs"]["draft-release"]["if"]
        .as_str()
        .unwrap()
        .contains("github.ref_type == 'tag'"));
}
