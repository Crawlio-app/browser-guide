import Foundation
import LocalAuthentication
import Security

public protocol APIKeyStoring: Sendable {
    func readAPIKey() throws -> String?
    func saveAPIKey(_ apiKey: String) throws
    func deleteAPIKey() throws
}

public enum KeychainStoreError: Error, Equatable, Sendable {
    case osStatus(OSStatus)
    case timedOut
    /// The delete call crossed its deadline after Security.framework started it.
    /// Its eventual success or failure cannot be known at the response boundary.
    case deleteOutcomeUnknown

    public init(status: OSStatus) {
        self = .osStatus(status)
    }

    public var status: OSStatus? {
        guard case .osStatus(let status) = self else { return nil }
        return status
    }
}

protocol KeychainBackend: Sendable {
    func read(service: String, account: String) throws -> String?
    func save(_ apiKey: String, service: String, account: String) throws
    func delete(service: String, account: String) throws
}

/// Stores the OpenAI key as a generic password through Security.framework only.
public struct KeychainStore: APIKeyStoring, Sendable {
    public static let defaultService = BrowserGuideHostConstants.hostName + ".openai-api-key"
    public static let defaultAccount = "openai-api-key"
    /// The first Keychain access after the helper binary changes takes several
    /// seconds while macOS evaluates the new code signature against the item's
    /// access control list (observed ~4s; instant once cached). The timeout must
    /// ride that out while staying under the extension's eight-second deadlines.
    public static let defaultOperationTimeout: TimeInterval = 6

    public let service: String
    public let account: String

    private let backend: any KeychainBackend
    private let operationTimeout: TimeInterval
    private let operationQueue: DispatchQueue
    private let reconciliationState: KeychainReconciliationState

    public init(
        service: String = Self.defaultService,
        account: String = Self.defaultAccount,
        operationTimeout: TimeInterval = Self.defaultOperationTimeout
    ) {
        self.init(
            service: service,
            account: account,
            operationTimeout: operationTimeout,
            backend: SecurityFrameworkKeychainBackend()
        )
    }

    init(
        service: String,
        account: String,
        operationTimeout: TimeInterval,
        backend: any KeychainBackend
    ) {
        precondition(!service.isEmpty && !account.isEmpty)
        precondition(operationTimeout > 0 && operationTimeout <= 10)
        self.service = service
        self.account = account
        self.operationTimeout = operationTimeout
        self.backend = backend
        operationQueue = DispatchQueue(
            label: "com.crawlio.browser-guide.keychain.\(UUID().uuidString)",
            qos: .userInitiated
        )
        reconciliationState = KeychainReconciliationState()
    }

    public func readAPIKey() throws -> String? {
        try performWithTimeout {
            try backend.read(service: service, account: account)
        }
    }

    public func saveAPIKey(_ apiKey: String) throws {
        let state = KeychainOperationState<Void>()
        let completion = DispatchSemaphore(value: 0)
        operationQueue.async {
            guard state.beginPreparation() else { return }
            do {
                try resolvePendingReconciliation()
                let previousValue = try backend.read(service: service, account: account)
                guard state.beginExecution() else { return }

                let result: Result<Void, KeychainStoreError>
                do {
                    try backend.save(apiKey, service: service, account: account)
                    result = .success(())
                } catch {
                    result = .failure(normalize(error))
                }

                if state.finish(result) {
                    completion.signal()
                } else {
                    // Security.framework calls cannot be cancelled once running. Restore
                    // the exact pre-save state before this serial queue serves another
                    // read or mutation, so a late save never becomes reported state.
                    reconcileTimedOutSave(previousValue: previousValue)
                }
            } catch {
                if state.finish(.failure(normalize(error))) {
                    completion.signal()
                }
            }
        }
        _ = try waitForCompletion(
            state: state,
            completion: completion,
            inFlightTimeoutError: .timedOut
        )
    }

    public func deleteAPIKey() throws {
        try performWithTimeout(inFlightTimeoutError: .deleteOutcomeUnknown) {
            try backend.delete(service: service, account: account)
        }
    }

    private func performWithTimeout<Value: Sendable>(
        inFlightTimeoutError: KeychainStoreError = .timedOut,
        _ operation: @escaping @Sendable () throws -> Value
    ) throws -> Value {
        let state = KeychainOperationState<Value>()
        let completion = DispatchSemaphore(value: 0)
        operationQueue.async {
            guard state.beginPreparation() else { return }
            do {
                try resolvePendingReconciliation()
                guard state.beginExecution() else { return }

                let result: Result<Value, KeychainStoreError>
                do {
                    result = .success(try operation())
                } catch {
                    result = .failure(normalize(error))
                }
                if state.finish(result) {
                    completion.signal()
                }
            } catch {
                if state.finish(.failure(normalize(error))) {
                    completion.signal()
                }
            }
        }

        return try waitForCompletion(
            state: state,
            completion: completion,
            inFlightTimeoutError: inFlightTimeoutError
        )
    }

    private func waitForCompletion<Value: Sendable>(
        state: KeychainOperationState<Value>,
        completion: DispatchSemaphore,
        inFlightTimeoutError: KeychainStoreError
    ) throws -> Value {
        if completion.wait(timeout: .now() + operationTimeout) == .success {
            guard let result = state.completedResult() else {
                throw KeychainStoreError.osStatus(errSecInternalComponent)
            }
            return try result.get()
        }

        switch state.resolveTimeout() {
        case .completed(let result):
            // The result won the deadline race but had not signalled the waiter yet.
            return try result.get()
        case .timedOutBeforeExecution:
            // Work still queued, or only performing preflight reconciliation, is now
            // cancelled and will never execute its requested Security.framework call.
            throw KeychainStoreError.timedOut
        case .timedOutInFlight:
            throw inFlightTimeoutError
        }
    }

    private func resolvePendingReconciliation() throws {
        guard let target = reconciliationState.pending else { return }
        do {
            try applyReconciliation(target)
            reconciliationState.pending = nil
        } catch {
            // Keep the target in memory. Every later operation must retry it before
            // it can read or mutate the durable item.
            reconciliationState.pending = target
            throw normalize(error)
        }
    }

    private func reconcileTimedOutSave(previousValue: String?) {
        let target: KeychainReconciliationTarget = previousValue.map {
            .restore($0)
        } ?? .remove
        do {
            try applyReconciliation(target)
            reconciliationState.pending = nil
        } catch {
            // The timeout response is already in flight. Retaining this target makes
            // reconciliation a hard gate for all subsequent reads and mutations.
            reconciliationState.pending = target
        }
    }

    private func applyReconciliation(_ target: KeychainReconciliationTarget) throws {
        switch target {
        case .remove:
            try backend.delete(service: service, account: account)
        case .restore(let previousValue):
            try backend.save(previousValue, service: service, account: account)
        }
    }

    private func normalize(_ error: Error) -> KeychainStoreError {
        (error as? KeychainStoreError) ?? .osStatus(errSecInternalComponent)
    }
}

private struct SecurityFrameworkKeychainBackend: KeychainBackend {
    func read(service: String, account: String) throws -> String? {
        var query = matchingQuery(service: service, account: account)
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnData as String] = true
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainStoreError(status: status) }
        guard let data = item as? Data,
              let value = String(data: data, encoding: .utf8),
              !value.isEmpty else {
            throw KeychainStoreError(status: errSecDecode)
        }
        return value
    }

    func save(_ apiKey: String, service: String, account: String) throws {
        guard let data = apiKey.data(using: .utf8), !data.isEmpty else {
            throw KeychainStoreError(status: errSecParam)
        }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(
            matchingQuery(service: service, account: account) as CFDictionary,
            attributes as CFDictionary
        )
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else { throw KeychainStoreError(status: updateStatus) }

        var addQuery = baseQuery(service: service, account: account)
        for (key, value) in attributes { addQuery[key] = value }
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw KeychainStoreError(status: addStatus) }
    }

    func delete(service: String, account: String) throws {
        let status = SecItemDelete(matchingQuery(service: service, account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainStoreError(status: status)
        }
    }

    private func matchingQuery(service: String, account: String) -> [String: Any] {
        var query = baseQuery(service: service, account: account)
        let authenticationContext = LAContext()
        authenticationContext.interactionNotAllowed = true
        query[kSecUseAuthenticationContext as String] = authenticationContext
        return query
    }

    private func baseQuery(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
    }
}

private enum KeychainReconciliationTarget: Sendable {
    case remove
    case restore(String)
}

/// Access is serialized by a KeychainStore's private operation queue.
private final class KeychainReconciliationState: @unchecked Sendable {
    var pending: KeychainReconciliationTarget?
}

private enum KeychainTimeoutResolution<Value: Sendable> {
    case completed(Result<Value, KeychainStoreError>)
    case timedOutBeforeExecution
    case timedOutInFlight
}

private final class KeychainOperationState<Value: Sendable>: @unchecked Sendable {
    private enum Phase {
        case queued
        case preparing
        case executing
        case completed(Result<Value, KeychainStoreError>)
        case timedOut
    }

    private let lock = NSLock()
    private var phase = Phase.queued

    func beginPreparation() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard case .queued = phase else { return false }
        phase = .preparing
        return true
    }

    func beginExecution() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard case .preparing = phase else { return false }
        phase = .executing
        return true
    }

    /// Returns true only while the caller is still waiting for this result.
    func finish(_ result: Result<Value, KeychainStoreError>) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        switch phase {
        case .preparing, .executing:
            phase = .completed(result)
            return true
        case .queued, .completed, .timedOut:
            return false
        }
    }

    func completedResult() -> Result<Value, KeychainStoreError>? {
        lock.lock()
        defer { lock.unlock() }
        guard case .completed(let result) = phase else { return nil }
        return result
    }

    func resolveTimeout() -> KeychainTimeoutResolution<Value> {
        lock.lock()
        defer { lock.unlock() }
        switch phase {
        case .completed(let result):
            return .completed(result)
        case .queued, .preparing:
            phase = .timedOut
            return .timedOutBeforeExecution
        case .executing:
            phase = .timedOut
            return .timedOutInFlight
        case .timedOut:
            return .timedOutInFlight
        }
    }
}
