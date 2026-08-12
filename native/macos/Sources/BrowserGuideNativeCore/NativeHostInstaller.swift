import Foundation

public enum NativeHostInstallStatus: String, Sendable {
    case notInstalled
    case needsRepair
    case installed
}

public enum NativeHostInstallerError: Error, LocalizedError, Sendable {
    case invalidExtensionOrigin
    case bundledHostMissing
    case installationFailed

    public var errorDescription: String? {
        switch self {
        case .invalidExtensionOrigin:
            return "The helper was built without a valid Browser Guide extension origin."
        case .bundledHostMissing:
            return "The native host is missing from the helper bundle. Rebuild the helper and try again."
        case .installationFailed:
            return "The user-level native host registration could not be updated."
        }
    }
}

public struct NativeHostInstallerConfiguration: Sendable {
    public let allowedOrigin: String
    public let bundledHostURL: URL
    public let homeDirectory: URL

    public init(allowedOrigin: String, bundledHostURL: URL, homeDirectory: URL) throws {
        guard Self.isValidExtensionOrigin(allowedOrigin) else {
            throw NativeHostInstallerError.invalidExtensionOrigin
        }
        self.allowedOrigin = allowedOrigin
        self.bundledHostURL = bundledHostURL
        self.homeDirectory = homeDirectory
    }

    public static func isValidExtensionOrigin(_ value: String) -> Bool {
        guard value.utf8.count == 52,
              value.hasPrefix("chrome-extension://"),
              value.hasSuffix("/") else { return false }
        let id = value.dropFirst("chrome-extension://".count).dropLast()
        return id.count == 32 && id.allSatisfy { ("a"..."p").contains(String($0)) }
    }
}

public struct NativeHostInstaller {
    private let configuration: NativeHostInstallerConfiguration
    private let fileManager: FileManager

    public init(configuration: NativeHostInstallerConfiguration, fileManager: FileManager = .default) {
        self.configuration = configuration
        self.fileManager = fileManager
    }

    public func status() -> NativeHostInstallStatus {
        let hostExists = fileManager.fileExists(atPath: installedHostURL.path)
        let anyManifestExists = (manifestURLs + obsoleteManifestURLs)
            .contains { fileManager.fileExists(atPath: $0.path) }
        if !hostExists && !anyManifestExists { return .notInstalled }
        guard fileManager.isExecutableFile(atPath: installedHostURL.path) else { return .needsRepair }
        guard let expected = try? manifestData() else { return .needsRepair }
        for manifestURL in manifestURLs {
            guard let installed = try? Data(contentsOf: manifestURL), installed == expected else {
                return .needsRepair
            }
        }
        return .installed
    }

    public func installOrRepair() throws {
        guard fileManager.isExecutableFile(atPath: configuration.bundledHostURL.path) else {
            throw NativeHostInstallerError.bundledHostMissing
        }
        do {
            try fileManager.createDirectory(
                at: installedHostURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try fileManager.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o700))],
                ofItemAtPath: installedHostURL.deletingLastPathComponent().path
            )
            let hostBytes = try Data(contentsOf: configuration.bundledHostURL, options: [.mappedIfSafe])
            try hostBytes.write(to: installedHostURL, options: [.atomic])
            try fileManager.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o700))],
                ofItemAtPath: installedHostURL.path
            )

            let manifest = try manifestData()
            for manifestURL in manifestURLs {
                try fileManager.createDirectory(
                    at: manifestURL.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try manifest.write(to: manifestURL, options: [.atomic])
                try fileManager.setAttributes(
                    [.posixPermissions: NSNumber(value: Int16(0o600))],
                    ofItemAtPath: manifestURL.path
                )
            }
            for obsoleteURL in obsoleteManifestURLs where fileManager.fileExists(atPath: obsoleteURL.path) {
                try fileManager.removeItem(at: obsoleteURL)
            }
        } catch let error as NativeHostInstallerError {
            throw error
        } catch {
            throw NativeHostInstallerError.installationFailed
        }
    }

    public func remove() throws {
        do {
            for manifestURL in manifestURLs + obsoleteManifestURLs
                where fileManager.fileExists(atPath: manifestURL.path) {
                try fileManager.removeItem(at: manifestURL)
            }
            if fileManager.fileExists(atPath: installedHostURL.path) {
                try fileManager.removeItem(at: installedHostURL)
            }
            let hostDirectory = installedHostURL.deletingLastPathComponent()
            if (try? fileManager.contentsOfDirectory(atPath: hostDirectory.path).isEmpty) == true {
                try fileManager.removeItem(at: hostDirectory)
            }
        } catch {
            throw NativeHostInstallerError.installationFailed
        }
    }

    public var installedHostURL: URL {
        configuration.homeDirectory
            .appendingPathComponent("Library/Application Support/Crawlio Browser Guide/Native Host", isDirectory: true)
            .appendingPathComponent(BrowserGuideHostConstants.hostName, isDirectory: false)
    }

    public var manifestURLs: [URL] {
        let applicationSupport = configuration.homeDirectory
            .appendingPathComponent("Library/Application Support", isDirectory: true)
        return [
            applicationSupport
                .appendingPathComponent("Google/Chrome/NativeMessagingHosts", isDirectory: true)
                .appendingPathComponent(BrowserGuideHostConstants.hostName + ".json"),
            applicationSupport
                .appendingPathComponent("Google/ChromeForTesting/NativeMessagingHosts", isDirectory: true)
                .appendingPathComponent(BrowserGuideHostConstants.hostName + ".json"),
        ]
    }

    private var obsoleteManifestURLs: [URL] {
        [configuration.homeDirectory
            .appendingPathComponent(
                "Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts",
                isDirectory: true
            )
            .appendingPathComponent(BrowserGuideHostConstants.hostName + ".json")]
    }

    private func manifestData() throws -> Data {
        let manifest: [String: Any] = [
            "name": BrowserGuideHostConstants.hostName,
            "description": "Browser Guide secure Realtime session helper",
            "path": installedHostURL.path,
            "type": "stdio",
            "allowed_origins": [configuration.allowedOrigin],
        ]
        return try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
    }
}
