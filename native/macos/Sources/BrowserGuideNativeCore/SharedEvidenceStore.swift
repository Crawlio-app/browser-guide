import Foundation

/// The "agent eyes" snapshot: when the user turns the panel toggle on, the
/// sanitized evidence of the shared tab is written here so local MCP clients
/// (Claude Code, Codex) can read what the user currently sees. Deleting the
/// file is the OFF state — readers treat absence as "eyes disabled".
public struct SharedEvidenceStore: Sendable {
    public static let maxTitleLength = 300
    public static let maxEvidenceLength = 200_000

    private let storeURL: URL

    public init() {
        self.init(storeURL: Self.defaultStoreURL())
    }

    init(storeURL: URL) {
        self.storeURL = storeURL
    }

    public static func defaultStoreURL() -> URL {
        if let override = ProcessInfo.processInfo.environment["BROWSER_GUIDE_EYES_PATH"],
           !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config", isDirectory: true)
            .appendingPathComponent("browser-guide", isDirectory: true)
            .appendingPathComponent("eyes.json", isDirectory: false)
    }

    public func publish(origin: String, title: String, evidence: String, now: Date = Date()) throws {
        let snapshot: [String: Any] = [
            "version": 1,
            "origin": origin,
            "title": String(title.prefix(Self.maxTitleLength)),
            "evidence": String(evidence.prefix(Self.maxEvidenceLength)),
            "captured_at": now.timeIntervalSince1970,
        ]
        let directory = storeURL.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: NSNumber(value: Int16(0o700))]
            )
            let data = try JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys])
            try data.write(to: storeURL, options: [.atomic])
            try FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o600))],
                ofItemAtPath: storeURL.path
            )
        } catch {
            throw CredentialStoreError.ioFailure("The shared evidence snapshot could not be written.")
        }
    }

    public func clear() {
        try? FileManager.default.removeItem(at: storeURL)
    }
}
