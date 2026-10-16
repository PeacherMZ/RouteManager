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
    assert_eq!(config["identifier"], "com.local.route-manager");
    assert!(template.contains("!define INSTALLFOLDER \"RouteManager\""));
    assert!(template.contains("StrCpy $INSTDIR \"$PROGRAMFILES64\\${INSTALLFOLDER}\""));
    // Changing the fresh-install default must retain registered upgrade locations.
    assert!(template.contains("Call RestorePreviousInstallLocation"));
    let restore = template
        .split("Function RestorePreviousInstallLocation")
        .nth(1)
        .unwrap()
        .split("FunctionEnd")
        .next()
        .unwrap();
    assert!(restore.contains("ReadRegStr $4 SHCTX \"${MANUPRODUCTKEY}\" \"\""));
    assert!(restore.contains("StrCmp $4 \"\" +2 0"));
    assert!(restore.contains("StrCpy $INSTDIR $4"));
}

#[test]
fn cargo_cache_never_restores_build_output_from_another_workspace() {
    let workflow: serde_yaml::Value =
        serde_yaml::from_str(include_str!("../../.github/workflows/build.yml")).unwrap();
    let steps = workflow["jobs"]["build"]["steps"].as_sequence().unwrap();
    let context_index = steps
        .iter()
        .position(|step| step["id"].as_str() == Some("cargo-cache-context"))
        .unwrap();
    let context = steps[context_index]["run"].as_str().unwrap();
    assert!(context.contains("process.env.GITHUB_WORKSPACE"));
    assert!(context.contains("process.env.GITHUB_OUTPUT"));
    let cache_index = steps
        .iter()
        .position(|step| {
            step["with"]["path"]
                .as_str()
                .is_some_and(|path| path.contains("artifacts/cargo"))
        })
        .unwrap();
    assert!(context_index < cache_index);
    let cache = &steps[cache_index]["with"];
    let scope =
        "rust-v2-${{ matrix.platform }}-1.99.0-${{ steps.cargo-cache-context.outputs.workspace }}-";
    assert!(cache["key"].as_str().unwrap().starts_with(scope));
    let restore_keys: Vec<_> = cache["restore-keys"].as_str().unwrap().lines().collect();
    assert!(!restore_keys.is_empty());
    assert!(restore_keys.iter().all(|key| key.starts_with(scope)));
}

#[test]
fn release_requires_both_platforms_and_pins_actions() {
    let workflow: serde_yaml::Value =
        serde_yaml::from_str(include_str!("../../.github/workflows/build.yml")).unwrap();
    let events = workflow["on"].as_mapping().unwrap();
    assert_eq!(
        events.len(),
        2,
        "only version tags and manual runs are allowed"
    );
    assert!(events.contains_key(serde_yaml::Value::from("workflow_dispatch")));
    let push = workflow["on"]["push"].as_mapping().unwrap();
    assert_eq!(push.len(), 1, "branch pushes must not trigger packaging");
    assert_eq!(
        workflow["on"]["push"]["tags"],
        serde_yaml::to_value(["v*"]).unwrap()
    );
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
    assert_eq!(
        workflow["jobs"]["draft-release"]["if"].as_str(),
        Some("github.event_name == 'push' && github.ref_type == 'tag'")
    );
}
