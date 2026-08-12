import Foundation
import XCTest
@testable import BrowserGuideNativeCore

final class NativeHostInstallerTests: XCTestCase {
    func testInstallsRepairsAndRemovesBothUserLevelChromeRegistrations() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let sourceHost = root.appendingPathComponent("host")
        try fileManager.createDirectory(at: home, withIntermediateDirectories: true)
        try Data("fixture-host".utf8).write(to: sourceHost)
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: sourceHost.path)
        defer { try? fileManager.removeItem(at: root) }

        let origin = "chrome-extension://bjgpnncbnjeahgfljjegblhmiklkcpmg/"
        let configuration = try NativeHostInstallerConfiguration(
            allowedOrigin: origin,
            bundledHostURL: sourceHost,
            homeDirectory: home
        )
        let installer = NativeHostInstaller(configuration: configuration)
        let chromeManifest = home.appendingPathComponent(
            "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.crawlio.browser_guide.json"
        )
        let chromeForTestingManifest = home.appendingPathComponent(
            "Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts/com.crawlio.browser_guide.json"
        )
        let obsoleteSpacedManifest = home.appendingPathComponent(
            "Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts/com.crawlio.browser_guide.json"
        )

        XCTAssertEqual(installer.status(), .notInstalled)
        try fileManager.createDirectory(
            at: obsoleteSpacedManifest.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("obsolete".utf8).write(to: obsoleteSpacedManifest)
        XCTAssertEqual(installer.status(), .needsRepair)
        try installer.installOrRepair()
        XCTAssertEqual(installer.status(), .installed)
        XCTAssertEqual(try Data(contentsOf: installer.installedHostURL), Data("fixture-host".utf8))
        XCTAssertEqual(Set(installer.manifestURLs), Set([chromeManifest, chromeForTestingManifest]))
        XCTAssertFalse(fileManager.fileExists(atPath: obsoleteSpacedManifest.path))
        for manifestURL in installer.manifestURLs {
            let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL))
            let manifest = try XCTUnwrap(raw as? [String: Any])
            XCTAssertEqual(manifest["name"] as? String, "com.crawlio.browser_guide")
            XCTAssertEqual(manifest["path"] as? String, installer.installedHostURL.path)
            XCTAssertEqual(manifest["allowed_origins"] as? [String], [origin])
        }

        try Data("tampered".utf8).write(to: installer.manifestURLs[0])
        XCTAssertEqual(installer.status(), .needsRepair)
        try installer.installOrRepair()
        XCTAssertEqual(installer.status(), .installed)

        try fileManager.removeItem(at: installer.installedHostURL)
        XCTAssertEqual(installer.status(), .needsRepair)
        try installer.installOrRepair()
        XCTAssertEqual(installer.status(), .installed)

        try installer.remove()
        XCTAssertEqual(installer.status(), .notInstalled)
        XCTAssertFalse(fileManager.fileExists(atPath: installer.installedHostURL.path))
        XCTAssertTrue(installer.manifestURLs.allSatisfy { !fileManager.fileExists(atPath: $0.path) })
    }
}
