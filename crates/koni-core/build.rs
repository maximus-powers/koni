use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

use semver::Version;
use sha2::{Digest, Sha256};

const MINIMUM_NODE_VERSION: Version = Version::new(22, 19, 0);

fn supported_node_version(path: &PathBuf) -> Option<Version> {
    let output = Command::new(path).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8(output.stdout).ok()?;
    let version = Version::parse(version.trim().trim_start_matches('v')).ok()?;
    (version >= MINIMUM_NODE_VERSION).then_some(version)
}

fn main() {
    println!("cargo:rerun-if-env-changed=KONI_PINNED_NODE_PATH");
    let mut candidates = Vec::new();
    if let Some(path) = env::var_os("KONI_PINNED_NODE_PATH") {
        candidates.push(PathBuf::from(path));
    }
    candidates.extend(
        [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ]
        .map(PathBuf::from),
    );
    if let Some(path) = env::var_os("PATH") {
        candidates.extend(env::split_paths(&path).map(|root| root.join("node")));
    }
    let node = candidates
        .into_iter()
        .filter_map(|candidate| fs::canonicalize(candidate).ok())
        .find(|candidate| candidate.is_file() && supported_node_version(candidate).is_some())
        .expect(
            "building Koni's Pi runtime requires Node >=22.19; set KONI_PINNED_NODE_PATH for packaging",
        );
    let node_version = supported_node_version(&node)
        .expect("the selected build-pinned Node version must remain executable and supported");
    let bytes = fs::read(&node).expect("could not read the build-pinned Node image");
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    println!("cargo:rerun-if-changed={}", node.display());
    println!("cargo:rustc-env=KONI_PINNED_NODE_PATH={}", node.display());
    println!("cargo:rustc-env=KONI_PINNED_NODE_SHA256={encoded}");
    println!("cargo:rustc-env=KONI_PINNED_NODE_VERSION={node_version}");

    println!("cargo:rerun-if-env-changed=KONI_PINNED_BWRAP_PATH");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        let mut candidates = Vec::new();
        if let Some(path) = env::var_os("KONI_PINNED_BWRAP_PATH") {
            candidates.push(PathBuf::from(path));
        }
        candidates
            .extend(["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].map(PathBuf::from));
        if let Some(path) = env::var_os("PATH") {
            candidates.extend(env::split_paths(&path).map(|root| root.join("bwrap")));
        }
        let bwrap = candidates
            .into_iter()
            .filter_map(|candidate| fs::canonicalize(candidate).ok())
            .find(|candidate| candidate.is_file())
            .expect(
                "building Koni on Linux requires a pinned bubblewrap; set KONI_PINNED_BWRAP_PATH",
            );
        let digest =
            Sha256::digest(fs::read(&bwrap).expect("could not read build-pinned bubblewrap"));
        let mut encoded = String::with_capacity(64);
        for byte in digest {
            write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
        }
        println!("cargo:rerun-if-changed={}", bwrap.display());
        println!("cargo:rustc-env=KONI_PINNED_BWRAP_PATH={}", bwrap.display());
        println!("cargo:rustc-env=KONI_PINNED_BWRAP_SHA256={encoded}");
    } else {
        println!("cargo:rustc-env=KONI_PINNED_BWRAP_PATH=");
        println!("cargo:rustc-env=KONI_PINNED_BWRAP_SHA256=");
    }
}
