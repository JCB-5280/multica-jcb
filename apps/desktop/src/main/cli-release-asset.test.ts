import { describe, expect, it } from "vitest";

import { selectPlatformReleaseAssetName } from "./cli-release-asset";

describe("selectPlatformReleaseAssetName", () => {
  it("prefers the versioned archive name when both exist", () => {
    const assetNames = [
      "checksums.txt",
      "mato_darwin_amd64.tar.gz",
      "mato-cli-1.2.3-darwin-amd64.tar.gz",
    ];

    expect(selectPlatformReleaseAssetName(assetNames, "darwin", "x64")).toBe(
      "mato-cli-1.2.3-darwin-amd64.tar.gz",
    );
  });

  it("falls back to the legacy archive name when only legacy is present", () => {
    const assetNames = ["checksums.txt", "mato_darwin_amd64.tar.gz"];

    expect(selectPlatformReleaseAssetName(assetNames, "darwin", "x64")).toBe(
      "mato_darwin_amd64.tar.gz",
    );
  });

  it("matches the renamed darwin archive from release assets", () => {
    const assetNames = [
      "checksums.txt",
      "mato-cli-1.2.3-darwin-amd64.tar.gz",
      "mato-cli-1.2.3-darwin-arm64.tar.gz",
      "mato-cli-1.2.3-linux-amd64.tar.gz",
    ];

    expect(selectPlatformReleaseAssetName(assetNames, "darwin", "x64")).toBe(
      "mato-cli-1.2.3-darwin-amd64.tar.gz",
    );
  });

  it("matches the renamed windows zip archive", () => {
    const assetNames = [
      "mato-cli-1.2.3-windows-amd64.zip",
      "mato-cli-1.2.3-linux-amd64.tar.gz",
    ];

    expect(selectPlatformReleaseAssetName(assetNames, "win32", "x64")).toBe(
      "mato-cli-1.2.3-windows-amd64.zip",
    );
  });

  it("fails when the current platform asset is missing", () => {
    expect(() =>
      selectPlatformReleaseAssetName(
        ["mato-cli-1.2.3-linux-amd64.tar.gz", "mato_linux_amd64.tar.gz"],
        "darwin",
        "arm64",
      ),
    ).toThrow(/no release asset found/);
  });
});
