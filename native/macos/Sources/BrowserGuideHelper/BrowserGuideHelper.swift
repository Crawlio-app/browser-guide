import BrowserGuideNativeCore
import Darwin
import Foundation
import SwiftUI

private enum HelperAction: String {
    case install = "--install"
    case repair = "--repair"
    case remove = "--remove"
    case status = "--status"
}

private struct LaunchConfiguration {
    let installer: NativeHostInstaller
    let allowedOrigin: String

    init(arguments: [String], bundle: Bundle = .main) throws {
        let overrideOrigin: String?
        if let index = arguments.firstIndex(of: "--origin"), arguments.indices.contains(index + 1) {
            overrideOrigin = arguments[index + 1]
        } else {
            overrideOrigin = nil
        }
        guard let allowedOrigin = overrideOrigin
                ?? bundle.object(forInfoDictionaryKey: "BrowserGuideAllowedOrigin") as? String,
              let resources = bundle.resourceURL else {
            throw NativeHostInstallerError.invalidExtensionOrigin
        }
        let bundledHostURL = resources.appendingPathComponent(BrowserGuideHostConstants.hostName)
        let nativeConfiguration = try NativeHostInstallerConfiguration(
            allowedOrigin: allowedOrigin,
            bundledHostURL: bundledHostURL,
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser
        )
        self.allowedOrigin = allowedOrigin
        installer = NativeHostInstaller(configuration: nativeConfiguration)
    }
}

@main
struct BrowserGuideHelperApp: App {
    private let launchConfiguration: LaunchConfiguration?
    private let launchError: String?

    init() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        do {
            let configuration = try LaunchConfiguration(arguments: arguments)
            if let action = arguments.compactMap(HelperAction.init(rawValue:)).first {
                Self.perform(action: action, installer: configuration.installer)
            }
            launchConfiguration = configuration
            launchError = nil
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? "The helper configuration is invalid."
            if arguments.contains(where: { HelperAction(rawValue: $0) != nil }) {
                Self.writeLine(message, to: .standardError)
                Darwin.exit(1)
            }
            launchConfiguration = nil
            launchError = message
        }
    }

    var body: some Scene {
        WindowGroup("Browser Guide Helper") {
            if let configuration = launchConfiguration {
                InstallerView(installer: configuration.installer, allowedOrigin: configuration.allowedOrigin)
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 34))
                    Text("Helper unavailable")
                        .font(.title2.bold())
                    Text(launchError ?? "The helper configuration is invalid.")
                        .foregroundStyle(.secondary)
                }
                .frame(minWidth: 480, minHeight: 280)
            }
        }
        .windowResizability(.contentSize)
    }

    private static func perform(action: HelperAction, installer: NativeHostInstaller) -> Never {
        do {
            switch action {
            case .install, .repair:
                try installer.installOrRepair()
                writeLine("Browser Guide native host installed for this user.", to: .standardOutput)
            case .remove:
                try installer.remove()
                writeLine("Browser Guide native host registration removed for this user.", to: .standardOutput)
            case .status:
                writeLine(installer.status().rawValue, to: .standardOutput)
            }
            Darwin.exit(0)
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? "The helper operation failed."
            writeLine(message, to: .standardError)
            Darwin.exit(1)
        }
    }

    private static func writeLine(_ message: String, to handle: FileHandle) {
        if let data = (message + "\n").data(using: .utf8) {
            try? handle.write(contentsOf: data)
        }
    }
}

private struct InstallerView: View {
    let installer: NativeHostInstaller
    let allowedOrigin: String

    @State private var status: NativeHostInstallStatus
    @State private var feedback = ""

    init(installer: NativeHostInstaller, allowedOrigin: String) {
        self.installer = installer
        self.allowedOrigin = allowedOrigin
        _status = State(initialValue: installer.status())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 14) {
                Image(systemName: "lock.shield")
                    .font(.system(size: 34))
                    .foregroundStyle(.blue)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Browser Guide Native Helper")
                        .font(.title2.bold())
                    Text(statusLabel)
                        .foregroundStyle(.secondary)
                }
            }

            Text("Registers the signed-in user’s native messaging host for Google Chrome and Chrome for Testing. No administrator password is required.")
                .fixedSize(horizontal: false, vertical: true)

            Text(allowedOrigin)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)

            if !feedback.isEmpty {
                Text(feedback)
                    .font(.callout)
                    .foregroundStyle(feedback.hasPrefix("Could not") ? .red : .secondary)
            }

            HStack {
                Button(status == .notInstalled ? "Install" : "Repair") {
                    performInstall()
                }
                .buttonStyle(.borderedProminent)

                Button("Remove", role: .destructive) {
                    performRemove()
                }
                .disabled(status == .notInstalled)

                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
            }
        }
        .padding(24)
        .frame(width: 520)
    }

    private var statusLabel: String {
        switch status {
        case .notInstalled: "Not installed"
        case .needsRepair: "Installed files need repair"
        case .installed: "Installed for this user"
        }
    }

    private func performInstall() {
        do {
            try installer.installOrRepair()
            status = installer.status()
            feedback = "Registration is ready. Restart Chrome if Browser Guide was already open."
        } catch {
            feedback = "Could not install the native host. "
                + ((error as? LocalizedError)?.errorDescription ?? "Try rebuilding the helper.")
        }
    }

    private func performRemove() {
        do {
            try installer.remove()
            status = installer.status()
            feedback = "Registration removed. The Keychain API key remains until Browser Guide forgets it."
        } catch {
            feedback = "Could not remove the native host registration."
        }
    }
}
