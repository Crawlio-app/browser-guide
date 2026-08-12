import Foundation

/// Per-site conversational memory, stored beside the credentials file in the
/// harness config directory. Local-only, bounded, user-clearable.
public struct SiteMemoryStore: Sendable {
    public static let maxNotesPerOrigin = 10
    public static let maxOrigins = 50
    public static let maxQuestionLength = 300
    public static let maxAnswerLength = 500

    private let storeURL: URL

    public init() {
        self.init(storeURL: Self.defaultStoreURL())
    }

    init(storeURL: URL) {
        self.storeURL = storeURL
    }

    public static func defaultStoreURL() -> URL {
        if let override = ProcessInfo.processInfo.environment["BROWSER_GUIDE_MEMORY_PATH"],
           !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config", isDirectory: true)
            .appendingPathComponent("browser-guide", isDirectory: true)
            .appendingPathComponent("memory.json", isDirectory: false)
    }

    public func notes(for origin: String) throws -> [[String: Any]] {
        guard let store = try loadStore(),
              let site = store[origin] as? [String: Any],
              let notes = site["notes"] as? [[String: Any]] else { return [] }
        return notes
    }

    public func append(origin: String, question: String, answer: String, now: Date = Date()) throws {
        var store = (try loadStore()) ?? [:]
        var site = store[origin] as? [String: Any] ?? [:]
        var notes = site["notes"] as? [[String: Any]] ?? []
        notes.append([
            "q": String(question.prefix(Self.maxQuestionLength)),
            "a": String(answer.prefix(Self.maxAnswerLength)),
            "at": now.timeIntervalSince1970,
        ])
        if notes.count > Self.maxNotesPerOrigin {
            notes.removeFirst(notes.count - Self.maxNotesPerOrigin)
        }
        site["notes"] = notes
        site["updatedAt"] = now.timeIntervalSince1970
        store[origin] = site

        // Bound the number of remembered origins; drop the least recently used.
        let origins = store.keys.filter { $0.hasPrefix("http") }
        if origins.count > Self.maxOrigins {
            let sorted = origins.sorted { left, right in
                let leftAt = ((store[left] as? [String: Any])?["updatedAt"] as? Double) ?? 0
                let rightAt = ((store[right] as? [String: Any])?["updatedAt"] as? Double) ?? 0
                return leftAt < rightAt
            }
            for stale in sorted.prefix(origins.count - Self.maxOrigins) {
                store.removeValue(forKey: stale)
            }
        }
        try persist(store)
    }

    public func clear(origin: String?) throws {
        if let origin {
            var store = (try loadStore()) ?? [:]
            store.removeValue(forKey: origin)
            try persist(store)
        } else if FileManager.default.fileExists(atPath: storeURL.path) {
            try? FileManager.default.removeItem(at: storeURL)
        }
    }

    private func loadStore() throws -> [String: Any]? {
        guard FileManager.default.fileExists(atPath: storeURL.path) else { return nil }
        guard let data = try? Data(contentsOf: storeURL),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            // Damaged memory is disposable: start fresh rather than fail requests.
            return nil
        }
        return object
    }

    private func persist(_ store: [String: Any]) throws {
        let directory = storeURL.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: NSNumber(value: Int16(0o700))]
            )
            let data = try JSONSerialization.data(withJSONObject: store, options: [.sortedKeys])
            try data.write(to: storeURL, options: [.atomic])
            try FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o600))],
                ofItemAtPath: storeURL.path
            )
        } catch {
            throw CredentialStoreError.ioFailure("The site memory store could not be written.")
        }
    }
}
