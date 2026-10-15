fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=macos/helper.m");
        let root = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
        let directory = root.join("../artifacts/native");
        std::fs::create_dir_all(&directory).unwrap();
        let helper = directory.join("route-manager-helper");
        let arch = if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("aarch64") {
            "arm64"
        } else {
            "x86_64"
        };
        let mut compiler = std::process::Command::new("/usr/bin/clang");
        compiler.args([
            "-arch",
            arch,
            "-mmacosx-version-min=13.0",
            "-fobjc-arc",
            "-O2",
            "-Wall",
            "-Wextra",
            "-Wno-unused-parameter",
            "-framework",
            "Foundation",
            "-framework",
            "SystemConfiguration",
        ]);
        if std::env::var("PROFILE").as_deref() == Ok("debug") {
            compiler.arg("-DROUTE_MANAGER_DEVELOPMENT");
        }
        let status = compiler
            .arg(root.join("macos/helper.m"))
            .arg("-o")
            .arg(&helper)
            .status()
            .expect("clang is required");
        assert!(status.success(), "macOS native helper compilation failed");
        let status = std::process::Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-", "--timestamp=none"])
            .arg(&helper)
            .status()
            .unwrap();
        assert!(status.success(), "native helper ad-hoc signing failed");
        let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        std::fs::copy(
            &helper,
            out.ancestors().nth(3).unwrap().join("route-manager-helper"),
        )
        .unwrap();
    }
    #[cfg(feature = "desktop")]
    {
        let windows =
            tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows.manifest"));
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("failed to build Tauri application");
    }
}
