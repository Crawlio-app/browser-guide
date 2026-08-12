import Security
import XCTest
@testable import BrowserGuideNativeCore

final class KeychainStoreTests: XCTestCase {
    func testRoundTripsUpdatesAndAlwaysDeletesTemporaryService() throws {
        let store = KeychainStore(
            service: "com.crawlio.browser-guide.tests." + UUID().uuidString,
            account: "temporary-test-key"
        )
        do {
            try store.deleteAPIKey()
            defer { try? store.deleteAPIKey() }

            XCTAssertNil(try store.readAPIKey())
            try store.saveAPIKey("sk-" + String(repeating: "a", count: 24))
            XCTAssertEqual(try store.readAPIKey(), "sk-" + String(repeating: "a", count: 24))
            try store.saveAPIKey("sk-" + String(repeating: "b", count: 24))
            XCTAssertEqual(try store.readAPIKey(), "sk-" + String(repeating: "b", count: 24))
            try store.deleteAPIKey()
            XCTAssertNil(try store.readAPIKey())
        } catch let error as KeychainStoreError
            where error.status == errSecInteractionNotAllowed || error.status == errSecNotAvailable {
            throw XCTSkip("A usable login Keychain is unavailable in this test environment.")
        }
    }

    func testSecurityOperationReturnsAtConfiguredTimeoutInsteadOfHangingHost() throws {
        let store = KeychainStore(
            service: "com.crawlio.browser-guide.tests.timeout",
            account: "temporary-test-key",
            operationTimeout: 0.02,
            backend: SlowKeychainBackend(delay: 0.3)
        )
        let started = ContinuousClock.now

        XCTAssertThrowsError(try store.readAPIKey()) { error in
            XCTAssertEqual(error as? KeychainStoreError, .timedOut)
        }
        let elapsed = started.duration(to: .now)
        XCTAssertLessThan(elapsed, .milliseconds(200))
        XCTAssertEqual(KeychainStore.defaultOperationTimeout, 6)
    }

    func testTimedOutSaveIsRolledBackBeforeAReadCanObserveIt() throws {
        let backend = DelayedMutationKeychainBackend(saveDelay: 0.12)
        let store = KeychainStore(
            service: "com.crawlio.browser-guide.tests.late-save",
            account: "temporary-test-key",
            operationTimeout: 0.02,
            backend: backend
        )
        let call = KeychainCall()
        DispatchQueue.global(qos: .userInitiated).async {
            call.capture { try store.saveAPIKey("sk-" + String(repeating: "c", count: 24)) }
        }

        XCTAssertEqual(backend.saveStarted.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(call.finished.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(call.error, .timedOut)

        // A read queued while the late save is still running must time out rather
        // than report the unconfirmed key as configured.
        XCTAssertThrowsError(try store.readAPIKey()) { error in
            XCTAssertEqual(error as? KeychainStoreError, .timedOut)
        }

        XCTAssertEqual(backend.deleteCompleted.wait(timeout: .now() + 1), .success)
        XCTAssertNil(backend.storedValue)
        XCTAssertNil(try store.readAPIKey())
    }

    func testTimedOutReplacementRestoresThePreviousKey() throws {
        let previousKey = "sk-" + String(repeating: "p", count: 24)
        let backend = DelayedMutationKeychainBackend(
            initialValue: previousKey,
            saveDelay: 0.08
        )
        let store = KeychainStore(
            service: "com.crawlio.browser-guide.tests.late-replacement",
            account: "temporary-test-key",
            operationTimeout: 0.02,
            backend: backend
        )

        XCTAssertThrowsError(try store.saveAPIKey("sk-" + String(repeating: "n", count: 24))) { error in
            XCTAssertEqual(error as? KeychainStoreError, .timedOut)
        }
        XCTAssertEqual(backend.saveCompleted.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(backend.saveCompleted.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(backend.storedValue, previousKey)
        XCTAssertEqual(try store.readAPIKey(), previousKey)
    }

    func testTimedOutInFlightDeleteReportsUnknownUntilItsLateOutcomeIsObservable() throws {
        let backend = DelayedMutationKeychainBackend(
            initialValue: "sk-" + String(repeating: "d", count: 24),
            deleteDelay: 0.12
        )
        let store = KeychainStore(
            service: "com.crawlio.browser-guide.tests.late-delete",
            account: "temporary-test-key",
            operationTimeout: 0.02,
            backend: backend
        )
        let call = KeychainCall()
        DispatchQueue.global(qos: .userInitiated).async {
            call.capture { try store.deleteAPIKey() }
        }

        XCTAssertEqual(backend.deleteStarted.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(call.finished.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(call.error, .deleteOutcomeUnknown)
        XCTAssertEqual(backend.deleteCompleted.wait(timeout: .now() + 1), .success)
        XCTAssertNil(try store.readAPIKey())
    }

    func testSaveThatTimesOutWhileQueuedIsCancelledInsteadOfRunningLater() throws {
        let backend = BlockingFirstReadKeychainBackend()
        let store = KeychainStore(
            service: "com.crawlio.browser-guide.tests.queued-save",
            account: "temporary-test-key",
            operationTimeout: 0.02,
            backend: backend
        )
        let readCall = KeychainCall()
        DispatchQueue.global(qos: .userInitiated).async {
            readCall.capture { _ = try store.readAPIKey() }
        }
        XCTAssertEqual(backend.readStarted.wait(timeout: .now() + 1), .success)

        XCTAssertThrowsError(try store.saveAPIKey("sk-" + String(repeating: "q", count: 24))) { error in
            XCTAssertEqual(error as? KeychainStoreError, .timedOut)
        }
        backend.releaseRead.signal()
        XCTAssertEqual(readCall.finished.wait(timeout: .now() + 1), .success)

        XCTAssertNil(try store.readAPIKey())
        XCTAssertEqual(backend.saveCount, 0)
    }
}

private struct SlowKeychainBackend: KeychainBackend {
    let delay: TimeInterval

    func read(service: String, account: String) throws -> String? {
        Thread.sleep(forTimeInterval: delay)
        return nil
    }

    func save(_ apiKey: String, service: String, account: String) throws {
        Thread.sleep(forTimeInterval: delay)
    }

    func delete(service: String, account: String) throws {
        Thread.sleep(forTimeInterval: delay)
    }
}

private final class DelayedMutationKeychainBackend: KeychainBackend, @unchecked Sendable {
    let saveStarted = DispatchSemaphore(value: 0)
    let saveCompleted = DispatchSemaphore(value: 0)
    let deleteStarted = DispatchSemaphore(value: 0)
    let deleteCompleted = DispatchSemaphore(value: 0)

    private let lock = NSLock()
    private let saveDelay: TimeInterval
    private let deleteDelay: TimeInterval
    private var value: String?

    init(
        initialValue: String? = nil,
        saveDelay: TimeInterval = 0,
        deleteDelay: TimeInterval = 0
    ) {
        value = initialValue
        self.saveDelay = saveDelay
        self.deleteDelay = deleteDelay
    }

    var storedValue: String? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func read(service: String, account: String) throws -> String? {
        storedValue
    }

    func save(_ apiKey: String, service: String, account: String) throws {
        saveStarted.signal()
        Thread.sleep(forTimeInterval: saveDelay)
        lock.lock()
        value = apiKey
        lock.unlock()
        saveCompleted.signal()
    }

    func delete(service: String, account: String) throws {
        deleteStarted.signal()
        Thread.sleep(forTimeInterval: deleteDelay)
        lock.lock()
        value = nil
        lock.unlock()
        deleteCompleted.signal()
    }
}

private final class KeychainCall: @unchecked Sendable {
    let finished = DispatchSemaphore(value: 0)

    private let lock = NSLock()
    private var capturedError: KeychainStoreError?

    var error: KeychainStoreError? {
        lock.lock()
        defer { lock.unlock() }
        return capturedError
    }

    func capture(_ operation: () throws -> Void) {
        do {
            try operation()
        } catch let error as KeychainStoreError {
            lock.lock()
            capturedError = error
            lock.unlock()
        } catch {
            lock.lock()
            capturedError = .osStatus(errSecInternalComponent)
            lock.unlock()
        }
        finished.signal()
    }
}

private final class BlockingFirstReadKeychainBackend: KeychainBackend, @unchecked Sendable {
    let readStarted = DispatchSemaphore(value: 0)
    let releaseRead = DispatchSemaphore(value: 0)

    private let lock = NSLock()
    private var shouldBlockRead = true
    private var saves = 0

    var saveCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return saves
    }

    func read(service: String, account: String) throws -> String? {
        lock.lock()
        let block = shouldBlockRead
        shouldBlockRead = false
        lock.unlock()
        if block {
            readStarted.signal()
            _ = releaseRead.wait(timeout: .now() + 1)
        }
        return nil
    }

    func save(_ apiKey: String, service: String, account: String) throws {
        lock.lock()
        saves += 1
        lock.unlock()
    }

    func delete(service: String, account: String) throws {}
}
